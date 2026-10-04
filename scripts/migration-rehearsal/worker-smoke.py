#!/usr/bin/env python3
"""用 bwrap 隔离 PID、网络及写权限，启动现有 upstream bundle 做只读 HTTP smoke。"""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from urllib.parse import quote


def inner(checkout, run, bun):
    env = dict(os.environ)
    project = quote(env.get('MIGRATION_TEST_PROJECT', 'vault'), safe='')
    env.update({
        'CLAUDE_MEM_DATA_DIR': str(run), 'CLAUDE_CONFIG_DIR': str(run/'claude'),
        'CLAUDE_MEM_ENV_FILE': str(run/'empty.env'), 'CLAUDE_MEM_MODES_DIR': str(checkout/'plugin/modes'),
        'CLAUDE_MEM_WORKER_PORT': '37791', 'CLAUDE_MEM_WORKER_HOST': '127.0.0.1',
        'CLAUDE_MEM_RUNTIME': 'worker', 'CLAUDE_MEM_CHROMA_ENABLED': 'false',
        'CLAUDE_MEM_CLOUD_SYNC_TOKEN': '', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID': '',
        'CLAUDE_MEM_CLOUD_SYNC_HUB_URL': '', 'CLAUDE_MEM_TELEMETRY': 'false', 'DO_NOT_TRACK': '1',
        'CLAUDE_MEM_TRANSCRIPTS_ENABLED': 'false', 'CLAUDE_MEM_TELEGRAM_ENABLED': 'false',
        'CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED': 'false', 'CLAUDE_MEM_GROK_BOT_INJECT_ENABLED': 'false',
        'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED': 'false', 'CLAUDE_MEM_CCS_ALIGN_ENABLED': 'false',
        'CLAUDE_MEM_QUEUE_ENGINE': 'sqlite', 'CLAUDE_MEM_WELCOME_HINT_ENABLED': 'false',
        'CLAUDE_MEM_PROVIDER': 'openrouter', 'CLAUDE_MEM_OPENROUTER_BASE_URL': 'http://127.0.0.1:1/v1',
        'CLAUDE_MEM_OPENROUTER_API_KEY': '',
        'NODE_PATH': str(run/'node_modules'),
    })
    report = {'status': 'running', 'isolation': {'pidNamespace': True, 'networkNamespace': True,
              'rootReadonly': True, 'productionDataHidden': True, 'chromaEnabled': False,
              'cloudSyncEnabled': False, 'modelRequests': False}, 'http': {}}
    def request(path):
        with urllib.request.urlopen('http://127.0.0.1:37791'+path, timeout=8) as response:
            return response.read().decode()
    with open(run/'worker.log', 'wb') as log:
        process = subprocess.Popen([bun, str(checkout/'plugin/scripts/worker-service.cjs'), '--daemon'], env=env, cwd=run, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 45
            ready = False
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('Worker exited before readiness, code '+str(process.returncode))
                try:
                    readiness = json.loads(request('/api/readiness'))
                    ready = True
                    break
                except Exception:
                    time.sleep(.25)
            if not ready:
                raise RuntimeError('Worker readiness timeout')
            health = json.loads(request('/api/health'))
            report['http']['health'] = {k: health.get(k) for k in ['status', 'version']}
            report['http']['readiness'] = {'http200': True}
            assert health.get('version') == '13.29.0'
            sync = json.loads(request('/api/sync/status'))
            assert sync.get('configured') is False
            report['http']['syncConfigured'] = False
            for platform in ['claude', 'codex']:
                result = json.loads(request('/api/search/observations?project='+project+'&platformSource='+platform+'&limit=5'))
                text = '\n'.join(item.get('text','') for item in result.get('content',[]))
                assert 'Found 5 observation(s)' in text
                context = request('/api/context/inject?project='+project+'&platformSource='+platform)
                assert 0 < len(context) <= 10000 and 'No previous sessions' not in context
                report['http'][platform] = {'searchResultCount': 5, 'contextCharacters': len(context)}
            report['status'] = 'passed'
        except Exception as error:
            report['status'] = 'failed'
            report['error'] = type(error).__name__ + ': ' + str(error).split('\n')[0]
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            report['workerStopped'] = True
            (run/'report.json').write_text(json.dumps(report, indent=2)+'\n')
            print(json.dumps(report))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    if sys.argv[1:2] == ['--inner']:
        raise SystemExit(inner(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]))
    checkout, source, run = map(lambda p: Path(p).resolve(), sys.argv[1:4])
    if str(source).startswith('/data/claude/') or str(run).startswith('/data/claude/'):
        raise SystemExit('Production paths forbidden')
    run.mkdir(mode=0o700)  # 拒绝复用已有目录
    with sqlite3.connect('file:'+str(source)+'?mode=ro', uri=True) as src, sqlite3.connect(run/'claude-mem.db') as dst:
        assert src.execute('SELECT count(*) FROM pending_messages').fetchone()[0] == 0
        src.backup(dst)
    (run/'empty.env').touch(mode=0o600)
    (run/'claude').mkdir()
    if len(sys.argv) > 4:
        runtime_zod = Path(sys.argv[4]).resolve()
        installed = json.loads((runtime_zod/'package.json').read_text())
        expected = json.loads((checkout/'plugin/package.json').read_text())['dependencies']['zod']
        assert installed['name'] == 'zod' and '^'+installed['version'] == expected
        shutil.copytree(runtime_zod, run/'node_modules/zod')
    bun = shutil.which('bun')
    assert bun and shutil.which('bwrap')
    cmd = ['bwrap', '--ro-bind', '/', '/', '--bind', str(run), str(run), '--tmpfs', '/tmp', '--dev', '/dev',
           '--tmpfs', '/data/claude', '--tmpfs', '/data/codex', '--unshare-pid', '--unshare-net',
           '--proc', '/proc', '--die-with-parent', '/usr/bin/python3', str(Path(__file__).resolve()),
           '--inner', str(checkout), str(run), bun]
    # 不继承宿主任何 provider/cloud/proxy 凭据。
    env = {'PATH': '/usr/bin:/bin:/home/uther/.bun/bin', 'LANG': 'C.UTF-8'}
    env['MIGRATION_TEST_PROJECT'] = os.environ.get('MIGRATION_TEST_PROJECT', 'vault')
    raise SystemExit(subprocess.run(cmd, env=env, timeout=70).returncode)

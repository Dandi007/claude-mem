#!/usr/bin/env python3
"""逐字段比较两个只读副本，仅输出数量和列名，不输出记忆正文。"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sqlite3

TABLES = ('observations', 'session_summaries', 'sdk_sessions', 'user_prompts', 'recover', 'pending_messages')


def connect(path):
    return sqlite3.connect(Path(path).resolve(strict=True).as_uri() + '?mode=ro', uri=True)


def compare(before, after):
    a, b = connect(before), connect(after)
    report = {'tables': {}}
    for table in TABLES:
        ac = [r[1] for r in a.execute(f'PRAGMA table_info("{table}")')]
        bc = [r[1] for r in b.execute(f'PRAGMA table_info("{table}")')]
        common = [c for c in ac if c in bc]
        columns = ','.join('"'+c+'"' for c in common)
        key = 'id' if 'id' in common else 'rowid'
        rows_a = a.execute(f'SELECT {key},{columns} FROM "{table}" ORDER BY {key}')
        rows_b = b.execute(f'SELECT {key},{columns} FROM "{table}" ORDER BY {key}')
        ra, rb = next(rows_a, None), next(rows_b, None)
        changed = Counter(); removed = added = count_a = count_b = 0
        while ra is not None or rb is not None:
            if rb is None or (ra is not None and ra[0] < rb[0]):
                removed += 1; count_a += 1; ra = next(rows_a, None)
            elif ra is None or rb[0] < ra[0]:
                added += 1; count_b += 1; rb = next(rows_b, None)
            else:
                count_a += 1; count_b += 1
                for col, av, bv in zip(common, ra[1:], rb[1:]):
                    if av != bv: changed[col] += 1
                ra, rb = next(rows_a, None), next(rows_b, None)
        report['tables'][table] = {'before':count_a, 'after':count_b, 'removed_ids':removed,
            'added_ids':added,'changed_columns':dict(changed),'added_columns':[c for c in bc if c not in ac],
            'removed_columns':[c for c in ac if c not in bc]}
    report['lineage'] = {}
    for table in ('observations', 'session_summaries'):
        expected = {r[0]:r[1:] for r in a.execute(f'''SELECT m.id, COALESCE(st.id,nt.id),
            COALESCE(st.platform_source,nt.platform_source),m.project
            FROM {table} m LEFT JOIN sdk_sessions st ON m.session_db_id=st.id
            LEFT JOIN sdk_sessions nt ON m.memory_session_id=nt.memory_session_id''')}
        actual = {r[0]:r[1:] for r in b.execute(f'''SELECT m.id,s.id,s.platform_source,m.project
            FROM {table} m LEFT JOIN sdk_sessions s ON m.memory_session_id=s.memory_session_id''')}
        report['lineage'][table] = {'expected':len(expected),'actual':len(actual),
            'missing_or_changed':sum(actual.get(k)!=v for k,v in expected.items()),
            'unresolved':sum(v[0] is None for v in actual.values())}
    report['foreign_key_violations'] = len(b.execute('PRAGMA foreign_key_check').fetchall())
    a.close(); b.close()
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('before');p.add_argument('after');p.add_argument('--report',type=Path)
    args = p.parse_args()
    report=compare(args.before,args.after)
    text=json.dumps(report,indent=2,ensure_ascii=False)+'\n'
    if args.report: args.report.write_text(text)
    print(text)

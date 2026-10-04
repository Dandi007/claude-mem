#!/usr/bin/env python3
"""在新建 SQLite 副本中修复本地 stable linkage；绝不原地写源数据库。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def repair(source: Path, output: Path):
    source = source.resolve(strict=True)
    output = output.resolve()
    if output.exists() or source == output:
        raise ValueError("输出必须是不存在的新文件，不能覆盖源数据库")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    origin = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    db = sqlite3.connect(output)
    origin.backup(db)
    origin.close()
    os.chmod(output, 0o600)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    changes = []
    before_fk = len(db.execute("PRAGMA foreign_key_check").fetchall())
    with db:
        # 父 session 无 natural key 时，只接受所有已知 stable 子记录一致的未占用值。
        parents = db.execute("""
            SELECT DISTINCT s.id FROM sdk_sessions s
            WHERE s.memory_session_id IS NULL AND (
              EXISTS (SELECT 1 FROM observations o WHERE o.session_db_id=s.id)
              OR EXISTS (SELECT 1 FROM session_summaries m WHERE m.session_db_id=s.id))
        """).fetchall()
        for parent in parents:
            keys = {r[0] for r in db.execute("""
              SELECT memory_session_id FROM observations WHERE session_db_id=?
              UNION SELECT memory_session_id FROM session_summaries WHERE session_db_id=?
            """, (parent[0], parent[0])) if r[0]}
            if len(keys) != 1:
                raise ValueError("缺 key 的父 session 存在歧义，必须人工核对")
            key = keys.pop()
            if db.execute("SELECT 1 FROM sdk_sessions WHERE memory_session_id=?", (key,)).fetchone():
                raise ValueError("候选 natural key 已被占用")
            for table in ("observations", "session_summaries"):
                if db.execute(f"SELECT 1 FROM {table} WHERE memory_session_id=? AND session_db_id IS NOT NULL AND session_db_id<>?", (key, parent[0])).fetchone():
                    raise ValueError("候选 natural key 被其他 stable session 子记录引用")
            db.execute("UPDATE sdk_sessions SET memory_session_id=? WHERE id=?", (key, parent[0]))
            changes.append({"table": "sdk_sessions", "id": parent[0], "old_key": None, "new_key": key})

        for table in ("observations", "session_summaries"):
            rows = db.execute(f"""
              SELECT m.*, st.memory_session_id AS target_key, st.id AS stable_owner,
                     nt.id AS natural_owner
              FROM {table} m
              LEFT JOIN sdk_sessions st ON m.session_db_id=st.id
              LEFT JOIN sdk_sessions nt ON m.memory_session_id=nt.memory_session_id
            """).fetchall()
            for row in rows:
                if row["stable_owner"] and row["natural_owner"] and row["stable_owner"] != row["natural_owner"]:
                    raise ValueError("stable / natural 关联冲突，拒绝自动选择")
                if not row["stable_owner"] and not row["natural_owner"]:
                    raise ValueError("记录没有可恢复的 session 关联")
                target = row["target_key"]
                if not target or target == row["memory_session_id"]:
                    continue
                change = {"table": table, "id": row["id"], "old_key": row["memory_session_id"], "new_key": target}
                if table == "observations":
                    content_hash = hashlib.sha256("\0".join([target, row["title"] or "", row["narrative"] or ""]).encode()).hexdigest()[:16]
                    change.update(old_hash=row["content_hash"], new_hash=content_hash)
                    db.execute("UPDATE observations SET memory_session_id=?,content_hash=? WHERE id=?", (target, content_hash, row["id"]))
                else:
                    db.execute("UPDATE session_summaries SET memory_session_id=? WHERE id=?", (target, row["id"]))
                changes.append(change)
        # 旧 prompt 可只有 content_session_id；上游搜索只 JOIN session_db_id。
        for row in db.execute("SELECT id,session_db_id,content_session_id FROM user_prompts").fetchall():
            owners = db.execute("SELECT id FROM sdk_sessions WHERE content_session_id=?", (row["content_session_id"],)).fetchall()
            if len(owners) != 1:
                raise ValueError("prompt natural owner 不唯一，拒绝自动补齐")
            owner = owners[0][0]
            if row["session_db_id"] is not None and row["session_db_id"] != owner:
                raise ValueError("prompt stable / natural owner 冲突")
            if row["session_db_id"] is None:
                db.execute("UPDATE user_prompts SET session_db_id=? WHERE id=?", (owner, row["id"]))
                changes.append({"table": "user_prompts", "id": row["id"], "old_session_db_id": None, "new_session_db_id": owner})
        after_fk = db.execute("PRAGMA foreign_key_check").fetchall()
        if after_fk:
            raise ValueError(f"修复后仍存在 {len(after_fk)} 条 FK violations")
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("SQLite quick_check 失败")
    # 上游 migration 49 会截断 concepts 冒号后的说明，预先保全原字段。
    concepts = [{"id": row["id"], "concepts": row["concepts"]} for row in db.execute(
        "SELECT id,concepts FROM observations WHERE concepts LIKE '%:%' ORDER BY id")]
    archive = output.with_suffix(".concepts-originals.json")
    archive.write_text(json.dumps(concepts, ensure_ascii=False, indent=2) + "\n")
    os.chmod(archive, 0o600)
    db.close()
    ledger = output.with_suffix(".lineage-ledger.json")
    ledger.write_text(json.dumps(changes, ensure_ascii=False, indent=2) + "\n")
    os.chmod(ledger, 0o600)
    report = {"source": str(source), "output": str(output), "before_fk_violations": before_fk,
              "after_fk_violations": 0, "changes": {t: sum(x["table"] == t for x in changes)
                for t in ("sdk_sessions", "observations", "session_summaries", "user_prompts")}, "ledger": str(ledger), "concepts_archive": str(archive), "concepts_archived": len(concepts)}
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    repair(args.source, args.output)

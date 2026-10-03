#!/usr/bin/env python3
"""Offline metadata repair rehearsal. Writes only under the supplied rehearsal root.

Run with the production-compatible chromadb environment, never against its store:
  python chroma-probe.py /absolute/rehearsal-root /absolute/production/chroma
No document embedding or text queries are performed. Source copy requires stable
file stats before/after; this is a live-copy consistency check, not an atomic snapshot.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from collections import Counter
from pathlib import Path

os.environ.update(ANONYMIZED_TELEMETRY="False", HF_HUB_OFFLINE="1",
                  TRANSFORMERS_OFFLINE="1")


def stats(root):
    return {str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns,
                                      p.stat().st_ino)
            for p in root.rglob("*") if p.is_file()}


def normalized(source):
    source = re.sub(r"\s+", "-", (source or "unknown").strip().lower())
    if source == "transcript":
        return "codex"
    for name in ("codex", "cursor", "claude", "kimi"):
        if name in source:
            return name
    if source in ("agy", "antigravity") or source.startswith("antigravity-"):
        return "antigravity-cli"
    return source


def database(path):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def mappings(root):
    old = database(root / "baseline/claude-mem.db")
    new = database(root / "runs/repaired/claude-mem.db")
    result, counts = {}, Counter()
    for table, kind in (("observations", "observation"),
                        ("session_summaries", "session_summary")):
        expected = {r["id"]: dict(r) for r in old.execute(f"""
            SELECT o.id, s.id owner, s.memory_session_id memory_id,
                   s.platform_source platform FROM {table} o
            LEFT JOIN sdk_sessions s ON s.id=COALESCE(
                (SELECT id FROM sdk_sessions WHERE id=o.session_db_id),
                (SELECT id FROM sdk_sessions WHERE memory_session_id=o.memory_session_id))""")}
        for row in new.execute(f"""
            SELECT o.id, o.memory_session_id, o.project, s.id owner,
                   s.platform_source platform FROM {table} o
            LEFT JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id"""):
            e = expected[row["id"]]
            if e["owner"] is not None:
                assert row["owner"] == e["owner"], (kind, row["id"], "owner mismatch")
                if e["memory_id"] is not None:
                    assert row["memory_session_id"] == e["memory_id"]
                else:
                    counts[kind + "_parent_key_completed"] += 1
                assert normalized(row["platform"]) == normalized(e["platform"])
            else:
                counts[kind + "_unowned_sqlite"] += 1
            result[(kind, row["id"])] = {
                "memory_session_id": row["memory_session_id"],
                "project": row["project"], "platform_source": normalized(row["platform"])}
    for row in new.execute("""SELECT p.id, s.memory_session_id, s.project,
        s.platform_source FROM user_prompts p JOIN sdk_sessions s ON s.id=COALESCE(
            (SELECT id FROM sdk_sessions WHERE id=p.session_db_id),
            (SELECT id FROM sdk_sessions WHERE content_session_id=p.content_session_id))"""):
        result[("user_prompt", row["id"])] = {
            "memory_session_id": row["memory_session_id"], "project": row["project"],
            "platform_source": normalized(row["platform_source"])}
    return result, counts


def immutable_hash(ids, docs, vectors):
    h = hashlib.sha256()
    for key, doc, vec in sorted(zip(ids, docs, vectors), key=lambda x: x[0]):
        h.update(json.dumps([key, doc], ensure_ascii=False).encode())
        h.update(vec.tobytes())
    return h.hexdigest()


def repair_prompts(root, clone, run):
    """Complete prompt natural-key fallback on an already validated clone."""
    import chromadb
    from chromadb.config import Settings
    mapping, _ = mappings(root)
    client = chromadb.PersistentClient(path=str(clone),
        settings=Settings(anonymized_telemetry=False))
    report = {"status": "passed", "collections": {}, "network_embedding_calls": 0}
    for item in client.list_collections():
        name = item.name if hasattr(item, "name") else item
        col = client.get_collection(name, embedding_function=None)
        data = col.get(where={"doc_type": "user_prompt"},
                       include=["metadatas", "documents", "embeddings"])
        original_count = col.count()
        digest = immutable_hash(data["ids"], data["documents"], data["embeddings"])
        changes, patches, counts = [], [], Counter()
        for key, meta in zip(data["ids"], data["metadatas"]):
            entity = ("user_prompt", int(meta["sqlite_id"]))
            if entity not in mapping:
                counts["extra_snapshot_documents"] += 1
                continue
            change = {k: v for k,v in mapping[entity].items() if v is not None}
            for k,v in change.items():
                if meta.get(k) != v:
                    counts["changed_" + k] += 1
            if any(meta.get(k) != v for k,v in change.items()):
                changes.append(key)
                patches.append({**meta, **change})
        for start in range(0, len(changes), 250):
            col.update(ids=changes[start:start+250], metadatas=patches[start:start+250])
        after = col.get(where={"doc_type": "user_prompt"},
                       include=["metadatas", "documents", "embeddings"])
        assert digest == immutable_hash(after["ids"], after["documents"], after["embeddings"])
        assert original_count == col.count()
        for metadata in after["metadatas"]:
            entity = ("user_prompt", int(metadata["sqlite_id"]))
            if entity not in mapping:
                continue
            wanted = mapping[entity]
            assert all(metadata.get(k)==v for k,v in wanted.items() if v is not None)
        counts["updated_documents"] = len(changes)
        counts["verified_immutable_documents"] = len(after["ids"])
        seen = set()
        all_data = {"ids": [], "metadatas": []}
        for offset in range(0, original_count, 2000):
            batch = col.get(limit=2000, offset=offset, include=["metadatas"])
            all_data["ids"].extend(batch["ids"])
            all_data["metadatas"].extend(batch["metadatas"])
        platforms, samples = Counter(), {}
        extra_snapshot_ids = []
        for key, meta in zip(all_data["ids"], all_data["metadatas"]):
            match = re.fullmatch(r"(obs|summary|prompt)_(\d+)(?:_.*)?", key)
            assert match, "Unrecognized ID"
            kind = {"obs":"observation", "summary":"session_summary", "prompt":"user_prompt"}[match[1]]
            entity=(kind,int(match[2]))
            if entity not in mapping:
                extra_snapshot_ids.append(key)
                continue
            wanted=mapping[entity]
            assert all(meta.get(k)==v for k,v in wanted.items() if v is not None), (kind,entity[1])
            seen.add(entity)
            platforms[meta["platform_source"]] += 1
            samples.setdefault(meta["platform_source"],key)
        for platform,key in samples.items():
            vec=col.get(ids=[key],include=["embeddings"])["embeddings"][0]
            result=col.query(query_embeddings=[vec.tolist()],n_results=1,
                where={"platform_source":platform},include=["metadatas"])
            assert result["ids"][0] and result["metadatas"][0][0]["platform_source"]==platform
        missing=set(mapping)-seen
        report["collections"][name]={**dict(counts),
            "all_metadata_verified":len(all_data["ids"])-len(extra_snapshot_ids),
            "extra_snapshot_ids":extra_snapshot_ids,
            "present_entities_by_kind":dict(Counter(k for k,_ in seen)),
            "missing_entities_by_kind":dict(Counter(k for k,_ in missing)),
            "expected_platform_document_counts":dict(platforms),
            "platform_vector_queries_passed":len(samples)}
    (run / "prompt-completion-report.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("--attempt", default="chroma-repair")
    parser.add_argument("--resume-prompts", action="store_true")
    args = parser.parse_args()
    root, source = args.root.resolve(), args.source.resolve()
    assert re.fullmatch(r"chroma-repair(?:-[a-zA-Z0-9]+)?", args.attempt)
    assert root != source and root not in source.parents and source not in root.parents
    assert "migration-rehearsal" in root.name
    baseline = root / "baseline/chroma"
    run = root / "runs" / args.attempt
    run.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.resume_prompts:
        repair_prompts(root, run / "chroma", run)
        return
    report = {"source_copy_atomic": False, "source_stats_stable": False,
              "network_embedding_calls": 0, "collections": {}}
    try:
        if baseline.exists():
            prior = json.loads((root / "runs/chroma-repair/report.json").read_text())
            assert prior["source_stats_stable"] is True
            report["source_stats_stable"] = prior["source_stats_stable"]
            report["source_file_count"] = prior["source_file_count"]
            report["reused_baseline"] = True
        else:
            before = stats(source)
            shutil.copytree(source, baseline)
            after = stats(source)
            report["source_stats_stable"] = before == after
            report["source_file_count"] = len(before)
            assert before == after, "Source changed during copy; discard clone and retry"
            assert {k: v[:2] for k, v in before.items()} == {
                k: v[:2] for k, v in stats(baseline).items()}, "Clone stats mismatch"
        clone = run / "chroma"
        shutil.copytree(baseline, clone)
        mapping, counts = mappings(root)
        report["sqlite_counts"] = dict(counts)
        import chromadb
        from chromadb.config import Settings
        report["chromadb_version"] = chromadb.__version__
        client = chromadb.PersistentClient(path=str(clone),
                    settings=Settings(anonymized_telemetry=False))
        for item in client.list_collections():
            name = item.name if hasattr(item, "name") else item
            col = client.get_collection(name, embedding_function=None)
            info = Counter()
            seen, expected_platform = set(), Counter()
            samples = {}
            total = col.count()
            for offset in range(0, total, 250):
                data = col.get(limit=250, offset=offset,
                               include=["metadatas", "documents", "embeddings"])
                ids = data["ids"]
                digest = immutable_hash(ids, data["documents"], data["embeddings"])
                patch_ids, patches = [], []
                for key, meta, vec in zip(ids, data["metadatas"], data["embeddings"]):
                    info["documents"] += 1
                    match = re.fullmatch(r"(obs|summary|prompt)_(\d+)(?:_.*)?", key)
                    if not match:
                        info["unrecognized_document_ids"] += 1
                        continue
                    kind = {"obs": "observation", "summary": "session_summary",
                            "prompt": "user_prompt"}[match[1]]
                    entity = (kind, int(match[2]))
                    if entity not in mapping:
                        info["documents_missing_sqlite"] += 1
                        continue
                    assert meta["sqlite_id"] == entity[1] and meta["doc_type"] == kind
                    seen.add(entity)
                    change = {k: v for k, v in mapping[entity].items() if v is not None}
                    platform = change["platform_source"]
                    expected_platform[platform] += 1
                    samples.setdefault(platform, (key, vec.copy()))
                    if any(meta.get(k) != v for k, v in change.items()):
                        for k, v in change.items():
                            if meta.get(k) != v:
                                info["changed_" + k] += 1
                        patch_ids.append(key)
                        patches.append({**meta, **change})
                if patch_ids:
                    col.update(ids=patch_ids, metadatas=patches)
                    info["updated_documents"] += len(patch_ids)
                after_data = col.get(ids=ids, include=["metadatas", "documents", "embeddings"])
                assert digest == immutable_hash(after_data["ids"], after_data["documents"],
                                                after_data["embeddings"]), "Content/vector changed"
                for key, metadata in zip(after_data["ids"], after_data["metadatas"]):
                    if key in patch_ids:
                        assert metadata == patches[patch_ids.index(key)]
                info["verified_immutable_documents"] += len(ids)
            assert col.count() == total
            for platform, (key, vec) in samples.items():
                matched = col.get(where={"platform_source": platform}, include=[])
                assert len(matched["ids"]) >= expected_platform[platform]
                answer = col.query(query_embeddings=[vec.tolist()], n_results=1,
                                   where={"platform_source": platform}, include=["metadatas"])
                assert answer["ids"][0] and answer["metadatas"][0][0]["platform_source"] == platform
                info["platform_vector_queries_passed"] += 1
            info["sqlite_entities_present"] = len(seen)
            missing = set(mapping) - seen
            info["sqlite_entities_missing_documents"] = len(missing)
            report["collections"][name] = {**dict(info),
                "expected_platform_document_counts": dict(expected_platform),
                "missing_entities_by_kind": dict(Counter(k for k, _ in missing)),
                "present_entities_by_kind": dict(Counter(k for k, _ in seen))}
        report["status"] = "passed"
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = type(exc).__name__ + ": " + str(exc)
        raise
    finally:
        (run / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

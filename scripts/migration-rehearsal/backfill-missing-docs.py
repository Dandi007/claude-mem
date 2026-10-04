#!/usr/bin/env python3
"""Add only absent upstream-formatted document IDs to a scratch Chroma store."""
import argparse,json,os,hashlib,socket
from pathlib import Path
os.environ.update(ANONYMIZED_TELEMETRY='False',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1')
p=argparse.ArgumentParser();p.add_argument('chroma',type=Path);p.add_argument('expected',type=Path);p.add_argument('report',type=Path);p.add_argument('--apply',action='store_true');p.add_argument('--state-output',type=Path);p.add_argument('--collection',default='cm__claude-mem');args=p.parse_args()
args.chroma=args.chroma.resolve(strict=True);args.expected=args.expected.resolve(strict=True);args.report=args.report.resolve()
assert not str(args.chroma).startswith('/data/claude/'),'Production forbidden'
assert args.report not in (args.expected,args.expected.with_name(args.expected.name+'.manifest.json'))
assert not str(args.report).startswith('/data/claude/'),'Production report forbidden'
assert args.chroma not in args.report.parents,'Report cannot be inside Chroma store'
assert not args.report.exists(),'Report must be a new file'
manifest=json.loads(Path(str(args.expected)+'.manifest.json').read_text())
h=hashlib.sha256()
with args.expected.open('rb') as source:
 for chunk in iter(lambda:source.read(1024*1024),b''):h.update(chunk)
assert h.hexdigest()==manifest['sha256'],'Export manifest mismatch'
if args.state_output:
 assert args.apply,'Watermarks require verified --apply'
 args.state_output=args.state_output.resolve()
 assert not args.state_output.exists(),'State output must be a new file'
 assert not str(args.state_output).startswith('/data/claude/'),'Production state forbidden'
 assert args.chroma not in args.state_output.parents,'State cannot be inside Chroma store'
 assert args.state_output != args.report,'State and report must differ'
# Fail closed: default ONNX must be present locally, telemetry/network forbidden.
def offline(*a,**kw):raise RuntimeError('Network is disabled for vector migration')
socket.create_connection=offline
socket.socket.connect=offline
socket.socket.connect_ex=offline
import chromadb
from chromadb.config import Settings
from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
client=chromadb.PersistentClient(path=str(args.chroma),settings=Settings(anonymized_telemetry=False))
col=client.get_collection(args.collection,embedding_function=None)
existing=[]
for off in range(0,col.count(),2000):existing.extend(col.get(limit=2000,offset=off,include=[])['ids'])
existing.sort();seen=set(existing)
def digest():
 h=hashlib.sha256()
 for start in range(0,len(existing),1000):
  b=col.get(ids=existing[start:start+1000],include=['documents','embeddings','metadatas'])
  for k,d,v,m in sorted(zip(b['ids'],b['documents'],b['embeddings'],b['metadatas']),key=lambda x:x[0]):
   h.update(json.dumps([k,d,m],ensure_ascii=False,sort_keys=True).encode());h.update(v.tobytes())
 return h.hexdigest()
missing=[];expected=set();missing_entities=set()
with args.expected.open() as f:
 for line in f:
  d=json.loads(line);assert isinstance(d['document'],str),'Non-string document';assert d['id'] not in expected,'Duplicate upstream doc ID';expected.add(d['id'])
  if d['id'] not in seen:missing.append(d);missing_entities.add((d['metadata']['doc_type'],d['metadata']['sqlite_id']))
report={'existing_documents':len(existing),'expected_documents':len(expected),'missing_documents':len(missing),'missing_entities':len(missing_entities),'extra_existing_documents':len(seen-expected),'applied':args.apply,'empty_source_rows':manifest['emptyRows'],'status':'pending'}
with os.fdopen(os.open(args.report,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:json.dump(report,f,indent=2)
if args.apply:
 before=digest();ef=ONNXMiniLM_L6_V2() if missing else None
 for start in range(0,len(missing),64):
  batch=missing[start:start+64];docs=[d['document'] for d in batch];embeddings=ef(docs)
  col.add(ids=[d['id'] for d in batch],documents=docs,metadatas=[d['metadata'] for d in batch],embeddings=embeddings)
  print(json.dumps({'added':min(start+64,len(missing)),'total':len(missing)}),flush=True)
 after=digest();assert before==after,'Existing documents/vectors changed'
 present=set()
 for off in range(0,col.count(),2000):present.update(col.get(limit=2000,offset=off,include=[])['ids'])
 assert expected<=present,'Incomplete expected document coverage';assert seen<=present,'Existing IDs lost'
 assert col.count()==len(existing)+len(missing)
 report.update(existing_digest_before=before,existing_digest_after=after,final_documents=col.count(),missing_after=0)
 if args.state_output:
  with os.fdopen(os.open(args.state_output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:json.dump(manifest['state'],f,indent=2)
  report['watermark_projects']=len(manifest['state'])
report['status']='passed' if args.apply else 'dry-run'
args.report.write_text(json.dumps(report,indent=2));print(json.dumps(report))

/** Export exact upstream Chroma documents from a scratch migrated SQLite database. */
import { Database } from 'bun:sqlite';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSync, writeSync, closeSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [checkoutArg, databaseArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: bun export-chroma-docs.ts CHECKOUT SCRATCH_DB OUTPUT_JSONL');
const checkout=realpathSync(checkoutArg), database=realpathSync(databaseArg), output=join(realpathSync(resolve(outputArg, '..')), outputArg.split('/').at(-1)!);
const dataDir=process.env.CLAUDE_MEM_DATA_DIR;
if (!dataDir || !database.startsWith(realpathSync(dataDir)+'/')) throw new Error('Explicit scratch CLAUDE_MEM_DATA_DIR required');
if(database.startsWith('/data/claude/') || output.startsWith('/data/claude/')) throw new Error('Production forbidden');
const {ChromaSync}=await import(pathToFileURL(join(checkout,'src/services/sync/ChromaSync.ts')).href);
const sync:any=new ChromaSync('claude-mem');
const db=new Database(database,{readonly:true});
db.exec('BEGIN');
const fd=openSync(output,'wx',0o600);
const counts:Record<string,number>={};
const hash=createHash('sha256');
const state:Record<string,any>=Object.create(null);
const emptyRows:Record<string,number>={};
function emitRow(kind:string,row:any,docs:any[]){
 if (row.project === null || row.project === undefined) throw new Error('Row without project');
 const marks=state[row.project] ??= {observations:0,summaries:0,prompts:0,titleOnlyRequeued:true};
 marks[kind]=Math.max(marks[kind],row.id);
 if (!docs.length) emptyRows[kind]=(emptyRows[kind]??0)+1;
 emit(kind,docs);
}
function emit(kind:string, docs:any[]){counts[kind]=(counts[kind]??0)+docs.length;for(const doc of docs){doc.metadata=Object.fromEntries(Object.entries(doc.metadata).filter(([,v])=>v!==null && v!==undefined));if (typeof doc.document !== 'string') throw new Error('Non-string upstream document');
 const line=JSON.stringify(doc)+'\n';hash.update(line);writeSync(fd,line);}}
try {
 for(const row of db.query(`SELECT o.*,COALESCE(NULLIF(s.platform_source,''),'claude') platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id ORDER BY o.id`).iterate()) emitRow('observations',row,sync.formatObservationDocs(row));
 for(const row of db.query(`SELECT o.*,COALESCE(NULLIF(s.platform_source,''),'claude') platform_source FROM session_summaries o LEFT JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id ORDER BY o.id`).iterate()) emitRow('summaries',row,sync.formatSummaryDocs(row));
 for(const row of db.query(`SELECT p.*,s.memory_session_id,s.project,COALESCE(NULLIF(s.platform_source,''),'claude') platform_source FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id ORDER BY p.id`).iterate()) emitRow('prompts',row,[sync.formatUserPromptDoc(row)]);
} finally {closeSync(fd);db.close();}
writeFileSync(output+'.manifest.json',JSON.stringify({sha256:hash.digest('hex'),counts,emptyRows,state},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({counts,emptyRows,projects:Object.keys(state).length,output}));

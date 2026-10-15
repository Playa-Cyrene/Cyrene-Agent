import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationDatabaseClient } from "../storage/conversation-database-client";
import { ConversationDatabase } from "../storage/conversation-database";
import { withConversationDatabase } from "../../test-utils/conversation-storage";
import { reduceTranscriptProjection } from "./conversation-transcript-projection";
let root: string, client: ConversationDatabaseClient;
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),"cyrene-session-migration-")); client=new ConversationDatabaseClient(root); });
afterEach(async () => { await client.close(); fs.rmSync(root,{recursive:true,force:true}); });
function legacySession(extra: Record<string,unknown> = {}) {
  const record={id:"c1",schemaVersion:1,title:"old",identityId:null,mode:"chat",createdAt:1,updatedAt:2,
    messages:[{id:"u1",role:"user",content:"hello",at:1},{id:"a1",role:"model",content:"world",at:2}],...extra};
  const dir=path.join(root,"cyrene-chats","sessions");fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,"c1.json"),original=JSON.stringify(record);fs.writeFileSync(file,original);return {file,original};
}
describe("atomic legacy conversation import",()=>{
  it("imports v1 metadata and UI history once without modifying the source",async()=>{
    const source=legacySession();
    expect(await client.call('chats.getSessionRecord','c1')).toMatchObject({schemaVersion:2,messageCount:2});
    const before=await client.call<any[]>('transcript.audit','c1');
    expect(reduceTranscriptProjection(before).messages.map(message=>message.content)).toEqual(['hello','world']);
    expect(fs.readFileSync(source.file,'utf8')).toBe(source.original);
    await client.close();expect(await client.call('transcript.audit','c1')).toEqual(before);
  });
  it("rolls back every imported row and its completion marker on failure",async()=>{
    legacySession();const database=new ConversationDatabase(root);database.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON transcript_entries WHEN NEW.seq=2 BEGIN SELECT RAISE(ABORT,'INJECTED'); END");database.close();
    await expect(client.call('chats.getSessionRecord','c1')).rejects.toThrow();
    expect(withConversationDatabase(root,db=>db.prepare('SELECT count(*) AS n FROM transcript_entries').get()?.n)).toBe(0);
    expect(withConversationDatabase(root,db=>db.prepare('SELECT transcript_imported FROM conversations WHERE id=?').get('c1')?.transcript_imported)).toBe(0);
    withConversationDatabase(root,db=>db.exec('DROP TRIGGER fail_import'));
    expect(await client.call('chats.getSessionRecord','c1')).toMatchObject({schemaVersion:2,messageCount:2});
  });
  it("links a residual pending snapshot to its existing user without resending",async()=>{
    legacySession({pendingDispatch:{messageId:'u1',claimedAt:3,userMessage:{id:'u1',at:1,text:'hello',visibleContent:'hello'}}});
    await client.call('chats.getSessionRecord','c1');const entries=await client.call<any[]>('transcript.audit','c1');
    expect(entries.filter(entry=>entry.kind==='user')).toHaveLength(1);
    expect(await client.call('runs.all')).toEqual([]);
  });
  it("quarantines a conflicting residual input while preserving readable history",async()=>{
    legacySession({pendingDispatch:{messageId:'u1',claimedAt:3,userMessage:{id:'u1',at:1,text:'changed',visibleContent:'changed'}}});
    expect(await client.call('chats.getSessionRecord','c1')).toMatchObject({schemaVersion:2});
    expect(await client.call('chats.getPendingDispatch','c1')).toBeNull();
    expect(reduceTranscriptProjection(await client.call('transcript.audit','c1')).messages[0]?.content).toBe('hello');
    await client.call('chats.enqueuePendingMessage','c1',{id:'u2',rawContent:'next',visibleContent:'next'});
    expect(await client.call('chats.claimPendingMessage','c1')).toMatchObject({ok:true,claimed:true});
  });
  it("a malformed source cannot block an unrelated conversation",async()=>{
    const dir=path.join(root,'transcripts','broken');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'transcript.jsonl'),'not-json\n'+JSON.stringify({seq:2,id:'bad',kind:'user',at:1,payload:{text:'bad'}})+'\n');
    await expect(client.call('transcript.read','broken')).rejects.toThrow();
    const session=await client.call<any>('chats.createSession',{mode:'chat'});
    expect(session.id).toBeTruthy();expect((await client.call<any>('transcript.read',session.id)).throughSeq).toBe(0);
  });
});

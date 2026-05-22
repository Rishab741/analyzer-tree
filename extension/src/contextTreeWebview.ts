import * as vscode from 'vscode';
import { SerializableTree, DecisionNode, CommitMeta, KnownAgent } from './types';

// ── Flat node shape sent to the webview ───────────────────────────────────────

interface FlatNode {
    uuid: string;
    label: string;
    nodeType: string;
    role: string;
    depth: number;
    tokenCount: number;
    isPruned: boolean;
    isActiveLeaf: boolean;
    meta: {
        shortHash: string;
        agent: KnownAgent | null;
        agentDisplay: string | null;
        authorName: string;
        insertions: number;
        deletions: number;
        filesChanged: string[];
        message: string;
        branch: string;
    } | null;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ContextTreeWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'analyzerTree';

    private _view?: vscode.WebviewView;
    private _pending: object | null = null;

    constructor(
        private readonly onSaveContext: (uuids: string[]) => void,
        private readonly onSelectNode:  (uuid: string)    => void,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _ctx: vscode.WebviewViewResolveContext,
        _tok: vscode.CancellationToken,
    ): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html  = buildHtml();

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'saveContext') { this.onSaveContext(msg.selectedUuids ?? []); }
            if (msg.type === 'selectNode')  { this.onSelectNode(msg.uuid); }
        });

        // Re-send latest state whenever the view becomes visible (e.g. user opens sidebar)
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._pending) {
                webviewView.webview.postMessage(this._pending);
            }
        });

        // Send any state that arrived before the view was resolved
        if (this._pending) {
            webviewView.webview.postMessage(this._pending);
        }
    }

    refresh(structureJson: string): void {
        let nodes: FlatNode[] = [];
        let projectName = '';
        let totalTokens = 0;
        let budget = 0;
        let activeLeafUuid: string | null = null;

        try {
            const tree = JSON.parse(structureJson) as SerializableTree;
            activeLeafUuid = tree.active_leaf_uuid;
            totalTokens    = tree.total_tokens;
            budget         = tree.token_budget;
            nodes          = flattenTree(tree);
            projectName    = nodes[0]?.label ?? '';
        } catch { /* keep defaults */ }

        const payload = { type: 'update', nodes, projectName, totalTokens, budget, activeLeafUuid };

        // Always store the latest state so onDidChangeVisibility can re-send it
        this._pending = payload;

        // Send immediately regardless of visible state — VS Code queues it safely
        if (this._view) {
            this._view.webview.postMessage(payload);
        }
    }
}

// ── Tree flattening (DFS — primary child before alternative) ──────────────────

function flattenTree(tree: SerializableTree): FlatNode[] {
    const map = new Map<string, { node: DecisionNode; children: string[] }>();
    for (const sn of tree.nodes) { map.set(sn.node.uuid, sn); }

    const result: FlatNode[] = [];
    const visited = new Set<string>();

    function dfs(uuid: string): void {
        if (visited.has(uuid)) { return; }
        visited.add(uuid);
        const sn = map.get(uuid);
        if (!sn) { return; }
        const n = sn.node;

        let meta: FlatNode['meta'] = null;
        if (n.node_type === 'commit' && n.metadata) {
            try {
                const m = JSON.parse(n.metadata) as CommitMeta;
                meta = {
                    shortHash:   m.short_hash,
                    agent:       m.agent,
                    agentDisplay: m.agent_display,
                    authorName:  m.author_name,
                    insertions:  m.insertions,
                    deletions:   m.deletions,
                    filesChanged: m.files_changed,
                    message:     m.message,
                    branch:      m.branch,
                };
            } catch { /* ignore bad metadata */ }
        }

        result.push({
            uuid:        n.uuid,
            label:       n.label,
            nodeType:    n.node_type,
            role:        n.role,
            depth:       n.depth,
            tokenCount:  n.token_count,
            isPruned:    n.is_pruned,
            isActiveLeaf: n.uuid === tree.active_leaf_uuid,
            meta,
        });

        for (const child of sn.children) { if (child) { dfs(child); } }
    }

    dfs(tree.root_uuid);
    return result;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Context Tree</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#0d0d0f;color:#e2e2f0;
  height:100vh;display:flex;flex-direction:column;overflow:hidden;
  font-size:12px;
}

/* ── Header ───────────────────────────── */
#hdr{
  padding:8px 10px 6px;border-bottom:1px solid #17172a;
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;gap:8px;
}
#proj-pill{
  background:#130d26;border:1px solid #4c1d9555;border-radius:99px;
  padding:3px 10px;font-size:11px;font-weight:600;color:#a78bfa;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:58%;
}
#tok-info{font-size:10px;color:#44445a;white-space:nowrap}

/* ── Scroll list ──────────────────────── */
#list{flex:1;overflow-y:auto;padding:2px 0}
#list::-webkit-scrollbar{width:3px}
#list::-webkit-scrollbar-thumb{background:#22223a;border-radius:2px}

/* ── Row layout ───────────────────────── */
.row{display:flex;align-items:stretch;padding:1px 8px 1px 5px;position:relative}
.row.alt-row{padding-left:16px}
.row.first .tl::before{top:21px}
.row.last  .tl::before{bottom:calc(100% - 21px)}

/* Timeline column */
.tl{width:28px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;position:relative}
.tl::before{
  content:'';position:absolute;top:0;bottom:0;left:50%;
  width:1px;background:#18182e;transform:translateX(-50%);
}

/* Avatar circle */
.av{
  width:26px;height:26px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;flex-shrink:0;margin-top:9px;position:relative;z-index:1;
}
.av-human    {background:#1e1e32}
.av-root     {background:#2d1b69}
.av-claude   {background:#3b0764}
.av-copilot  {background:#7c2d12}
.av-gemini   {background:#1e3a8a}
.av-codex    {background:#064e3b}
.av-cursor   {background:#1e3a5f}
.av-aider    {background:#78350f}
.av-devin    {background:#701a75}
.av-coderabbit{background:#14532d}
.av-branch   {background:#164e63}

/* Card area */
.ca{flex:1;display:flex;align-items:center;padding:4px 0 4px 7px;gap:5px;min-width:0}

.card{
  flex:1;min-width:0;cursor:pointer;
  border-radius:7px;border:1px solid #18182a;
  background:#0f0f1c;padding:6px 9px;
  transition:border-color .12s,background .12s;
}
.card:hover{border-color:#2e2e50;background:#11112a}
.card.sel{border-color:#7c3aed;background:#0f0a24}
.card.active{border-color:#16a34a44;background:#0b1a10}
.card.is-root{border-color:#4c1d9533;background:#0c0820}

.lbl{
  font-size:11.5px;font-weight:500;color:#d4d4e8;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  display:flex;align-items:center;gap:4px;margin-bottom:2px;
}
.arr{font-size:10px;flex-shrink:0;color:#7c3aed;font-weight:700}
.arr.alt{color:#f97316}

.badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.hash{font-family:Consolas,Monaco,monospace;font-size:9.5px;color:#55556a;background:#12121e;padding:1px 4px;border-radius:3px}
.diff{font-family:monospace;font-size:9.5px;color:#22c55e;background:#052e16;padding:1px 5px;border-radius:3px}
.tok-badge{font-size:9.5px;color:#7c3aed;font-weight:700;letter-spacing:.01em}
.pruned-badge{font-size:9.5px;font-style:italic;color:#44445a}

/* Checkbox */
.chk{width:14px;height:14px;flex-shrink:0;cursor:pointer;accent-color:#7c3aed;margin-top:9px}

/* ── Footer ───────────────────────────── */
#ftr{
  padding:7px 10px;border-top:1px solid #17172a;
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;background:#0a0a12;
}
#sel-lbl{font-size:10.5px;color:#55556a;line-height:1.4}
#sel-lbl strong{color:#a78bfa}
#save-btn{
  background:#7c3aed;color:#fff;border:none;
  border-radius:5px;padding:5px 13px;
  font-size:10.5px;font-weight:700;cursor:pointer;letter-spacing:.06em;
  transition:background .12s;
}
#save-btn:hover{background:#6d28d9}
#save-btn:disabled{background:#1a1a2e;color:#33334a;cursor:default}

/* ── Empty state ──────────────────────── */
#empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:200px;color:#33334a;font-size:11px;text-align:center;gap:6px;line-height:1.7;
}
#empty .big{font-size:28px}
</style>
</head>
<body>
<div id="hdr">
  <div id="proj-pill">Loading…</div>
  <div id="tok-info">—</div>
</div>
<div id="list">
  <div id="empty">
    <div class="big">🌳</div>
    <div>Run <strong>Analyzer Tree: Initialize</strong><br>to build the context tree.</div>
  </div>
</div>
<div id="ftr">
  <div id="sel-lbl">Context Selection<br><strong id="stok">0</strong> tok selected</div>
  <button id="save-btn" disabled>SAVE CONTEXT</button>
</div>
<script>
const vscode = acquireVsCodeApi();
let allNodes = [];
let sel = new Set();

const AV = {
  claude:'🤖',gemini:'✨',copilot:'🐙',codex:'🧠',
  cursor:'🖱',aider:'🛠',devin:'🦾',coderabbit:'🐇'
};
const AV_CLS = {
  claude:'av-claude',gemini:'av-gemini',copilot:'av-copilot',codex:'av-codex',
  cursor:'av-cursor',aider:'av-aider',devin:'av-devin',coderabbit:'av-coderabbit'
};

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(n){return n>=1000?(n/1000).toFixed(1)+'k':String(n);}

function avInfo(node){
  if(node.nodeType==='root') return ['🌳','av-root'];
  if(node.meta&&node.meta.agent) return [AV[node.meta.agent]||'🤖', AV_CLS[node.meta.agent]||'av-human'];
  if(node.role==='alternative') return ['↗','av-branch'];
  return ['👤','av-human'];
}

function render(nodes){
  const list = document.getElementById('list');
  if(!nodes.length){
    list.innerHTML = '<div id="empty"><div class="big">🌳</div><div>Run <strong>Analyzer Tree: Initialize</strong><br>to build the context tree.</div></div>';
    return;
  }
  const html = [];
  const last = nodes.length - 1;
  for(let i=0;i<nodes.length;i++){
    const n = nodes[i];
    const [icon, avCls] = avInfo(n);
    const isRoot = n.nodeType==='root';
    const isAlt  = n.role==='alternative';
    const chkd   = sel.has(n.uuid);
    const uuid   = esc(n.uuid);

    let row = 'row';
    if(isAlt) row+=' alt-row';
    if(i===0) row+=' first';
    if(i===last) row+=' last';

    const arr = isRoot ? '' : (isAlt ? '<span class="arr alt">&#x2192;</span>' : '<span class="arr">&#x2190;</span>');

    let badges = '';
    if(n.meta){
      if(n.meta.shortHash) badges += '<span class="hash">'+esc(n.meta.shortHash)+'</span>';
      if(n.meta.insertions>0||n.meta.deletions>0){
        badges += '<span class="diff">+'+n.meta.insertions+'/-'+n.meta.deletions+'</span>';
      }
    }
    if(!isRoot&&n.tokenCount>300) badges += '<span class="tok-badge">'+fmt(n.tokenCount)+' tokens</span>';
    if(n.isPruned) badges += '<span class="pruned-badge">&#x2702; pruned</span>';

    let cardCls = 'card';
    if(isRoot) cardCls+=' is-root';
    if(chkd)   cardCls+=' sel';
    if(n.isActiveLeaf) cardCls+=' active';

    html.push(
      '<div class="'+row+'" data-uuid="'+uuid+'">',
        '<div class="tl"><div class="av '+avCls+'">'+icon+'</div></div>',
        '<div class="ca">',
          '<div class="'+cardCls+'" onclick="pick(\''+uuid+'\')">',
            '<div class="lbl">'+arr+'<span>'+esc(n.label)+'</span></div>',
            badges ? '<div class="badges">'+badges+'</div>' : '',
          '</div>',
          !isRoot ? '<input type="checkbox" class="chk"'+(chkd?' checked':'')+' onchange="toggle(\''+uuid+'\',this.checked)">' : '',
        '</div>',
      '</div>'
    );
  }
  list.innerHTML = html.join('');
  updateFtr();
}

function pick(uuid){ vscode.postMessage({type:'selectNode',uuid}); }

function toggle(uuid,on){
  if(on) sel.add(uuid); else sel.delete(uuid);
  const card = document.querySelector('[data-uuid="'+uuid+'"] .card');
  if(card) card.classList.toggle('sel',on);
  updateFtr();
}

function updateFtr(){
  let tot=0;
  sel.forEach(function(id){ const n=allNodes.find(function(x){return x.uuid===id;}); if(n) tot+=n.tokenCount; });
  document.getElementById('stok').textContent = fmt(tot);
  document.getElementById('save-btn').disabled = sel.size===0;
}

document.getElementById('save-btn').onclick = function(){
  vscode.postMessage({type:'saveContext', selectedUuids:[...sel]});
};

window.addEventListener('message', function(e){
  const m = e.data;
  if(m.type!=='update') return;
  allNodes = m.nodes||[];
  document.getElementById('proj-pill').textContent = (m.projectName||'—')+'  '+fmt(m.totalTokens||0)+' tok';
  document.getElementById('tok-info').textContent = fmt(m.totalTokens||0)+'/'+fmt(m.budget||0);
  render(allNodes);
});
</script>
</body>
</html>`;
}

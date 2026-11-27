// @ts-check
// Interaktivní oprávnění (volitelné, config `interactivePermissions`): Claude Code s
// `--permission-prompts host --permission-prompt-tool stdio` pošle na stdout `control_request` `can_use_tool`
// a čeká na `control_response` na stdin. Odpovědi jako v Claude Code: povolit jednou / povolit vždy / zamítnout.
//
// „Vždy“ = jen pravidla, která navrhl sám Claude Code (`permission_suggestions` typu addRules s behavior allow),
// uložená do .claude/settings.local.json projektu (destination localSettings) – stejně jako volba v terminálu.
// Návrhy setMode (např. acceptEdits), addDirectories ani nic jiného se nikdy nepoužijí: režim zůstává auto/plan.

export const DECISIONS = ['once', 'always', 'deny'];
/** Bez odpovědi do tohoto času → zamítnout, aby běh nevisel. */
export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RULES = 10;
const MAX_RULE = 500;
const TOOL_RX = /^[A-Za-z0-9_:.-]{1,100}$/;

/**
 * Z návrhů Claude Code vybere jen to, co smí „Povolit vždy“: addRules + allow + localSettings, rozumná pravidla.
 * @param {unknown} suggestions @returns {{type:'addRules', rules:{toolName:string, ruleContent?:string}[], behavior:'allow', destination:'localSettings'}[]}
 */
export function alwaysUpdates(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  const out = [];
  for (const s of suggestions) {
    if (!s || s.type !== 'addRules' || s.behavior !== 'allow' || s.destination !== 'localSettings' || !Array.isArray(s.rules)) continue;
    const rules = [];
    for (const r of s.rules.slice(0, MAX_RULES)) {
      if (!r || typeof r.toolName !== 'string' || !TOOL_RX.test(r.toolName)) continue;
      if (r.ruleContent !== undefined && (typeof r.ruleContent !== 'string' || r.ruleContent.length > MAX_RULE || /[\u0000-\u001f]/.test(r.ruleContent))) continue;
      rules.push(r.ruleContent !== undefined ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName });
    }
    if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' });
  }
  return out;
}

/** Pravidlo v zápisu Claude Code: Bash(npm test *). */
export const ruleLabel = (r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);

const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined);

/** Co ukázat v UI: příkaz, cesta, případně zkrácený JSON vstupu. */
export function inputPreview(toolName, input) {
  const i = input && typeof input === 'object' ? /** @type {any} */ (input) : {};
  return {
    command: cut(i.command, 4000),
    path: cut(i.file_path ?? i.notebook_path ?? i.path, 1000),
    url: cut(i.url, 1000),
    json: i.command || i.file_path || i.url ? undefined : cut(JSON.stringify(i), 2000),
  };
}

/** Úprava souboru pro kartu svolení (barevný rozdíl): Edit, MultiEdit, Write; texty omezené. */
export function editPreview(toolName, input) {
  const i = input && typeof input === 'object' ? /** @type {any} */ (input) : {};
  const file = cut(i.file_path, 1000);
  if (!file) return undefined;
  if (toolName === 'Edit') return { file, edits: [{ old: cut(i.old_string, 20000) ?? '', new: cut(i.new_string, 20000) ?? '' }] };
  if (toolName === 'MultiEdit' && Array.isArray(i.edits))
    return { file, edits: i.edits.slice(0, 20).map((e) => ({ old: cut(e?.old_string, 10000) ?? '', new: cut(e?.new_string, 10000) ?? '' })) };
  if (toolName === 'Write') return { file, edits: [{ old: '', new: cut(i.content, 40000) ?? '' }] };
  return undefined;
}

/** Otázka od Clauda (AskUserQuestion): otázky a možnosti, nic jiného. */
export function questionsPreview(input) {
  const qs = Array.isArray(/** @type {any} */ (input)?.questions) ? /** @type {any} */ (input).questions : [];
  const out = qs.slice(0, 4).filter((q) => typeof q?.question === 'string').map((q) => ({
    question: cut(q.question, 500), header: cut(q.header, 60), multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).filter((o) => typeof o?.label === 'string')
      .map((o) => ({ label: cut(o.label, 200), description: cut(o.description, 400) })),
  }));
  return out.length ? out : undefined;
}

/**
 * Odpověď pro stdin claude.
 * @param {string} requestId @param {'once'|'always'|'deny'|'timeout'} decision
 * @param {unknown} input původní vstup nástroje (klient ho nikdy nemění) @param {unknown} suggestions
 */
export function controlResponse(requestId, decision, input, suggestions) {
  let response;
  if (decision === 'deny') response = { behavior: 'deny', message: 'Uživatel akci zamítl.' };
  else if (decision === 'timeout') response = { behavior: 'deny', message: 'Bez odpovědi uživatele v časovém limitu – zamítnuto.' };
  else {
    response = { behavior: 'allow', updatedInput: input && typeof input === 'object' ? input : {} };
    const updates = decision === 'always' ? alwaysUpdates(suggestions) : [];
    if (updates.length) response.updatedPermissions = updates;
  }
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
}

/** Odpověď na jiný (nepodporovaný) control_request – claude dostane chybu, nic se nepovolí. */
export const controlError = (requestId, message = 'Nepodporováno.') =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: message } }) + '\n';

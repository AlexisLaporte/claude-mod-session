import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// Mod « session » : chaque session Claude Code a un nom, un rôle et un groupe,
// attachés à son identifiant (ils survivent à la reprise et au résumé).
// - Le nom : celui de /rename, par lequel les autres sessions la trouvent.
// - Le rôle : sa fiche « .claude/roles/<rôle>.md », cherchée en remontant depuis
//   son dossier, envoyée comme un fichier d'instructions et renvoyée quand elle
//   change sur disque.
// - Le groupe : sa fenêtre, nommée ; un onglet ouvert dedans le rejoint.
// Le terminal n'est connu que par un adaptateur, un exécutable externe
// (SESSION_TERMINAL, sinon terminals/kitty livré avec le mod) : il dit où tourne
// la session et sait aller à un onglet, l'ouvrir ou le fermer. Sans lui, le mod
// marche sans fenêtres : pas de groupe automatique, la commande de reprise à la place.
// Registre commun : ~/.local/state/claude-pool/sessions/<id>.json.
// /moi : voir et modifier les trois (/session est une commande de Claude Code). /sessions : chercher, aller à une
// session ouverte, rouvrir une session ou un groupe fermé.

// Où tourne une session, selon l'adaptateur : « place » lui est opaque et lui
// revient tel quel ; « window » nomme la fenêtre ; « order » range les onglets.
type Place = { place: unknown; window: string; order: number }
type Entry = {
  sid: string; name?: string; role?: string; rolesDir?: string; group?: string; cwd: string
  profile: string; transcript: string; term?: Place; at: number; busy: boolean; closedAt?: number
  waiting?: 'question' | 'réponse'; waitingSince?: number
}
type Fiche = { name: string; path: string; text: string; mtimeMs: number }

const BEAT_MS = 5000
const TERM_MS = 30000
const STALE_MS = 30000
const CHUNK = 4 * 1024 * 1024
const TITLE = /"customTitle":("(?:[^"\\]|\\.)*")/g
const CARD = 'session'
const LIST = 'sessions'
const ROLE_PANE = 'role'
const filter = atom({ plugin: 'session', key: 'filter' } as const, '', { shape: 'filter-1' })
const view = atom({ plugin: 'session', key: 'view' } as const, 'card', { shape: 'view-1' })
const search = atom({ plugin: 'session', key: 'search' } as const, '', { shape: 'search-1' })

// pendingName : le nom à donner par /rename, lancé par la minuterie (d'un
// hook de commande, /rename attendrait la fin du tour qui le lance).
// creating : le rôle dont la session rédige la fiche ; pris dès que le fichier existe.
const S: {
  sid: string; home: string; base: string; cwd: string; profile: string; transcript: string
  name?: string; role?: string; group?: string; rolesDir: string; fiche: Fiche | null
  term?: Place; termAt: number; busy: boolean; pendingName?: string; creating?: string; isOneShot?: boolean
  askingSince?: number; doneAt?: number
} = { sid: '', home: '', base: '', cwd: '', profile: '', transcript: '', rolesDir: '', fiche: null, termAt: 0, busy: false }

function key(name: string) {
  return name.normalize('NFC').toLowerCase()
}

async function readJson($: any, path: string): Promise<any> {
  try {
    return (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : undefined
  } catch {
    return undefined
  }
}

// Le dernier « customTitle » du transcript, en remontant au plus `depth` octets.
async function lastTitle($: any, path: string, depth: number): Promise<string | undefined> {
  if (!path || !(await $.fs.exists(path))) return undefined
  const size = (await $.fs.stat(path)).size
  let end = size
  while (end > 0 && size - end < depth) {
    const offset = Math.max(0, end - CHUNK)
    const text: string = await $.fs.read(path, { offset, length: end - offset })
    const found = [...text.matchAll(TITLE)].at(-1)
    if (found?.[1]) return JSON.parse(found[1])
    end = offset
  }
  return undefined
}

async function launchArgs($: any): Promise<string[]> {
  try {
    return (await $.fs.read('/proc/self/cmdline')).split('\u0000')
  } catch {
    return []
  }
}

function argAfter(args: string[], flags: string[]) {
  const i = args.findIndex(one => flags.includes(one))
  return i >= 0 ? args[i + 1] : undefined
}

// ---------- Terminal (adaptateur) ----------

async function terminalPath($: any): Promise<string> {
  const chosen = await $.env.get('SESSION_TERMINAL')
  if (chosen !== undefined) return chosen
  return `${(await $.process.hookEnv()).CLAUDE_PLUGIN_ROOT}/terminals/kitty`
}

// Une commande de l'adaptateur ; une erreur porte son message. SESSION_TERMINAL=''
// : pas d'adaptateur, chaque appel échoue en le disant.
async function terminal($: any, command: 'where' | 'focus' | 'close' | 'open', input?: unknown): Promise<string> {
  const path = await terminalPath($)
  if (!path) throw new Error('pas d\'adaptateur de terminal (SESSION_TERMINAL vide)')
  const out = await $.process.run([path, command], { stdin: input === undefined ? undefined : JSON.stringify(input), timeoutMs: 10000 })
  if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `${path} ${command} : code ${out.exitCode}`)
  return out.stdout
}

// Où tourne cette session ; undefined hors de tout terminal que l'adaptateur connaît.
async function where($: any): Promise<Place | undefined> {
  const text = (await terminal($, 'where')).trim()
  return text ? JSON.parse(text) : undefined
}

// ---------- Rôles ----------

// Le dossier des fiches : le premier « .claude/roles » en remontant ; '' sinon.
async function findRolesDir($: any): Promise<string> {
  let dir: string = S.cwd
  while (dir) {
    const here = `${dir === '/' ? '' : dir}/.claude/roles`
    if (await $.fs.exists(here)) return here
    if (dir === '/') return ''
    dir = dir.replace(/\/[^/]*$/, '') || '/'
  }
  return ''
}

// Les rôles disponibles : les fiches du dossier, hors « _MODELE.md » et autres « _… ».
async function roles($: any): Promise<string[]> {
  if (!S.rolesDir || !(await $.fs.exists(S.rolesDir))) return []
  return (await $.fs.list(S.rolesDir))
    .filter((one: any) => one.kind === 'file' && one.name.endsWith('.md') && !one.name.startsWith('_'))
    .map((one: any) => one.name.slice(0, -3).normalize('NFC'))
    .sort((a: string, b: string) => a.localeCompare(b, 'fr'))
}

async function findRole($: any, name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined
  return (await roles($)).find(one => key(one) === key(name))
}

async function readFiche($: any, name: string | undefined): Promise<Fiche | null> {
  const role = await findRole($, name)
  if (!role) return null
  const entry = (await $.fs.list(S.rolesDir)).find((one: any) => key(one.name) === key(`${role}.md`))
  const path = `${S.rolesDir}/${entry.name}`
  const { mtimeMs } = await $.fs.stat(path)
  return { name: role, path, text: await $.fs.read(path), mtimeMs }
}

function ficheText() {
  return `# Fiche de rôle de la session « ${S.fiche!.name} »\n` +
    `(source : ${S.fiche!.path} ; garde ce rôle, même après un résumé de contexte)\n\n${S.fiche!.text}`
}

// Relit la fiche du rôle ; si elle a changé, la redemande au moteur.
async function refreshFiche($: any) {
  if (!S.rolesDir) S.rolesDir = await findRolesDir($)
  if (S.creating && (await findRole($, S.creating))) {
    const made = (await findRole($, S.creating))!
    S.creating = undefined
    await setRole($, made)
    $.ui.toast(`Fiche « ${made} » créée : rôle pris.`)
  }
  const next = await readFiche($, S.role)
  const isChanged = next?.path !== S.fiche?.path || next?.mtimeMs !== S.fiche?.mtimeMs
  S.fiche = next
  if (isChanged) $.ui.invalidate('prompt.context')
}

// Donne le rôle (déjà vérifié) et, par commodité, le nom du rôle à la session.
async function setRole($: any, role: string) {
  S.role = role
  S.pendingName = role
  S.fiche = await readFiche($, role)
  await writeEntry($)
  await showStatus($)
  $.ui.invalidate('prompt.context')
}

// Fait rédiger la fiche par la session, avec la personne, d'après le gabarit du dossier.
async function createRole($: any, name: string) {
  const dir = S.rolesDir || `${await $.session.root()}/.claude/roles`
  S.creating = name
  const model = (await $.fs.exists(`${dir}/_MODELE.md`)) ? `le gabarit ${dir}/_MODELE.md` : 'un gabarit court (rôle en une phrase, périmètre, hors périmètre, superviseur, gestes qui demandent mon accord direct)'
  await $.prompt.submit({
    text: `Rédige avec moi la fiche de rôle « ${name} » de cette session, d'après ${model} et une ou deux fiches voisines de ${dir} s'il y en a. ` +
      `Pose-moi d'abord tes questions (rôle, périmètre, hors périmètre, superviseur, accords), puis montre-moi le texte. ` +
      `Après mon accord seulement, écris-le dans « ${dir}/${name}.md » : le mod session donne alors ce rôle à la session tout seul.`,
  })
}

// Un rôle choisi ou tapé : rôle existant, ou proposition de créer sa fiche.
async function chooseRole($: any, asked: string): Promise<string> {
  const name = asked.trim()
  if (!name) return ''
  const role = await findRole($, name)
  if (role) {
    const twin = await twinOf($, role)
    await setRole($, role)
    const warn = twin ? `\n⚠ « ${who(twin)} » tient déjà ce rôle : les messages adressés à « ${role} » risquent d'arriver à l'une ou l'autre.` : ''
    return `Rôle « ${role} » pris : la session prend ce nom et reçoit ${S.fiche!.path}.${warn}`
  }
  const answer = await $.ui.ask(`Pas de fiche « ${name} ». La créer avec cette session ?`, { options: ['Créer la fiche', 'Annuler'], header: 'Rôle' }).catch(() => 'Annuler')
  if (answer !== 'Créer la fiche') return `Pas de fiche « ${name} » : rien n'est changé.\n\n${await rolesText($)}`
  await createRole($, name)
  return `Fiche « ${name} » : la session la rédige avec toi ; le rôle est pris dès que le fichier existe.`
}

async function rolesText($: any) {
  const all = await roles($)
  if (!S.rolesDir) return `Aucun dossier .claude/roles au-dessus de ${S.cwd} : /role <nom> propose d'en créer la fiche.`
  return all.length ? `Rôles disponibles :\n${all.map(one => `- ${one}`).join('\n')}` : `Aucune fiche dans ${S.rolesDir} : /role <nom> propose d'en créer une.`
}

// ---------- Registre ----------

function entryPath(sid: string) {
  return `${S.base}/sessions/${sid}.json`
}

function claimPath(term: Place) {
  return `${S.base}/windows/${encodeURIComponent(term.window)}.json`
}

// Un « claude -p » (recall, scripts) ne s'inscrit pas : ce n'est pas une session qu'on rouvre.
async function writeEntry($: any, closedAt?: number) {
  if (!S.sid || S.isOneShot) return
  const entry: Entry = {
    sid: S.sid, name: S.name, role: S.role, rolesDir: S.rolesDir || undefined, group: S.group, cwd: S.cwd,
    profile: S.profile, transcript: S.transcript, term: S.term, at: await $.clock.now(), busy: S.busy, closedAt,
    ...waitingOf(),
  }
  await $.fs.write(entryPath(S.sid), JSON.stringify(entry))
}

// Toutes les sessions inscrites, sauf celles qui n'ont jamais reçu de message
// (pas de transcript : rien à reprendre).
async function entries($: any): Promise<Entry[]> {
  const dir = `${S.base}/sessions`
  if (!(await $.fs.exists(dir))) return []
  const all: Entry[] = []
  for (const one of await $.fs.list(dir)) {
    if (one.kind !== 'file' || !one.name.endsWith('.json')) continue
    const entry: Entry | undefined = await readJson($, `${dir}/${one.name}`)
    if (!entry?.sid) continue
    // Inscription de l'ancien mod (champ « kitty », avant le 25/11/2026) : à
    // retirer dès que toutes les sessions tournent sur ce mod.
    const old = (entry as any).kitty
    if (!entry.term && old) entry.term = { place: old, window: `${old.listen}#${old.started}#${old.os}`, order: old.tabIndex }
    const isEmpty = !entry.transcript || !(await $.fs.exists(entry.transcript))
    if (isEmpty && entry.sid !== S.sid) continue
    all.push(entry)
  }
  return all
}

// T'attend : une question ou une autorisation posée en plein tour (« question »),
// ou un tour fini auquel personne n'a encore répondu (« réponse »).
function waitingOf(): Pick<Entry, 'waiting' | 'waitingSince'> {
  if (S.askingSince) return { waiting: 'question', waitingSince: S.askingSince }
  if (S.doneAt && !S.busy) return { waiting: 'réponse', waitingSince: S.doneAt }
  return {}
}

// Une demande d'autorisation tranchée en quelques secondes (classifieur du mode
// auto) n'attendait personne : on ne compte qu'au-delà de ASK_MS.
const ASK_MS = 8000

function isWaiting(entry: Entry, now: number) {
  if (!entry.waiting || !entry.waitingSince) return false
  return entry.waiting === 'réponse' || now - entry.waitingSince > ASK_MS
}

function since(ms: number, now: number) {
  const minutes = Math.round((now - ms) / 60000)
  return minutes < 1 ? 'à l\'instant' : minutes < 60 ? `depuis ${minutes} min` : `depuis ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

async function waitingList($: any): Promise<Entry[]> {
  const now = await $.clock.now()
  return (await entries($))
    .filter(one => isAlive(one, now) && isWaiting(one, now))
    .sort((a, b) => (a.waiting === b.waiting ? 0 : a.waiting === 'question' ? -1 : 1) || a.waitingSince! - b.waitingSince!)
}

// ---------- Courrier entre sessions ----------
// Une session écrit à une autre par son nom ou son rôle, ouverte ou fermée :
// le message attend dans la boîte de la destinataire, qui le lit comme un tour
// dès qu'elle est ouverte et libre (quelques secondes si elle tourne déjà).

const WRITE_TOOL = 'ecrire'

function inboxDir(sid: string) {
  return `${S.base}/inbox/${sid}`
}

async function findTarget($: any, to: string): Promise<Entry> {
  const asked = to.trim().replace(/^@/, '')
  const wanted = key(asked)
  const all = (await entries($)).filter(one => one.sid !== S.sid)
  const byName = all.filter(one => one.name && key(one.name) === wanted)
  const bySid = asked.length >= 8 ? all.filter(one => one.sid.startsWith(asked)) : []
  const byRole = all.filter(one => one.role && key(one.role) === wanted)
  const found = byName.length ? byName : bySid.length ? bySid : byRole
  if (!found.length) throw new Error(`Aucune session nommée « ${asked} » (ni de ce rôle). /sessions pour les voir.`)
  return found.sort((a, b) => b.at - a.at)[0]!
}

async function sendMail($: any, to: string, text: string, isWaking: boolean) {
  if (!text.trim()) throw new Error('Message vide.')
  const target = await findTarget($, to)
  const now = await $.clock.now()
  const dir = inboxDir(target.sid)
  const made = await $.process.run(['mkdir', '-p', dir])
  if (made.exitCode !== 0) throw new Error(`Boîte de « ${who(target)} » inaccessible : ${made.stderr.trim()}`)
  await $.fs.write(`${dir}/${now}-${S.sid.slice(0, 8)}.json`, JSON.stringify({ from: S.name ?? S.fiche?.name ?? S.sid.slice(0, 8), fromSid: S.sid, at: now, text }))
  if (isAlive(target, now)) return `Remis à « ${who(target)} » (ouverte) : elle le lira à son prochain moment libre.`
  if (!isWaking) return `« ${who(target)} » est fermée : le message l'attend et sera lu à sa réouverture.`
  return `« ${who(target)} » était fermée. ${await reopen($, [target])} Elle lira le message en démarrant.`
}

async function deliverMail($: any) {
  if (S.busy || S.isOneShot || !S.base) return
  const dir = inboxDir(S.sid)
  if (!(await $.fs.exists(dir))) return
  const files: string[] = (await $.fs.list(dir)).filter((one: any) => one.kind === 'file' && one.name.endsWith('.json')).map((one: any) => one.name).sort()
  if (!files.length) return
  const now = await $.clock.now()
  const letters: { from: string; at: number; text: string }[] = []
  for (const name of files) {
    const letter = await readJson($, `${dir}/${name}`)
    await $.process.run(['rm', '-f', `${dir}/${name}`])
    if (letter?.text) letters.push(letter)
  }
  if (!letters.length) return
  const body = letters.map(one => `— de « ${one.from} » (${since(one.at, now)}) :\n${one.text}`).join('\n\n')
  await $.prompt.submit({ text: `${letters.length > 1 ? 'Messages reçus' : 'Message reçu'} d'autres sessions (réponds avec l'outil ${WRITE_TOOL} si besoin) :\n\n${body}` })
}

function isAlive(entry: Entry, now: number) {
  return !entry.closedAt && now - entry.at < STALE_MS
}

function who(entry: Entry) {
  return entry.name ?? entry.role ?? entry.sid.slice(0, 8)
}

function stateOf(entry: Entry, now: number) {
  if (isAlive(entry, now) && isWaiting(entry, now)) {
    return `⏳ ${entry.waiting === 'question' ? 'te pose une question' : 't\'attend'} ${since(entry.waitingSince!, now)}`
  }
  if (isAlive(entry, now)) return entry.busy ? '● au travail' : '● ouverte'
  const when = new Date(entry.closedAt ?? entry.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return entry.closedAt ? `○ fermée ${when}` : `○ perdue ${when}`
}

// Une autre session vivante qui tient ce rôle, dans le même dossier de fiches.
async function twinOf($: any, role: string): Promise<Entry | undefined> {
  const now = await $.clock.now()
  return (await entries($)).find(one => one.sid !== S.sid && isAlive(one, now) && one.role && key(one.role) === key(role) &&
    (!one.rolesDir || !S.rolesDir || one.rolesDir === S.rolesDir))
}

// Au démarrage : ce que le registre sait de cet identifiant ; sinon le rôle de
// l'ancien mod « roles » ; sinon celui de la session reprise (fork) ; sinon,
// une fois, le nom de la session s'il a une fiche.
async function loadIdentity($: any) {
  const mine: Entry | undefined = await readJson($, entryPath(S.sid))
  const args = await launchArgs($)
  S.group = mine?.group
  S.name = (await lastTitle($, S.transcript, 16 * CHUNK)) ?? argAfter(args, ['-n', '--name']) ?? mine?.name
  S.role = mine?.role ?? (await readJson($, `${S.home}/.local/state/fiche-role/sessions/${S.sid}.json`))?.role
  if (S.role) return
  const resumed = argAfter(args, ['-r', '--resume'])
  if (resumed && resumed !== S.sid) {
    const parent: Entry | undefined = await readJson($, entryPath(resumed))
    S.role = parent?.role
    S.group = S.group ?? parent?.group
  }
  S.role = S.role ?? (await findRole($, S.name))
}

// La fenêtre nommée l'emporte ; une session d'un groupe dans une fenêtre sans
// nom (rouverte) lui donne le nom de son groupe.
async function syncGroup($: any) {
  if (!S.term || S.isOneShot) return
  const claim = await readJson($, claimPath(S.term))
  if (claim && 'group' in claim) S.group = claim.group ?? undefined
  else if (S.group) await $.fs.write(claimPath(S.term), JSON.stringify({ group: S.group }))
}

// Un nom de groupe, ou undefined : la fenêtre (toutes ses sessions) n'a plus de groupe.
async function setGroup($: any, group: string | undefined) {
  S.group = group
  if (S.term) await $.fs.write(claimPath(S.term), JSON.stringify({ group: group ?? null }))
  await writeEntry($)
  await showStatus($)
  if (!group) return S.term ? 'Plus de groupe pour les sessions de cette fenêtre.' : 'Plus de groupe pour cette session.'
  return S.term
    ? `Groupe « ${group} » : les sessions de cette fenêtre le rejoignent dans les 5 s, un onglet ouvert ensuite aussi.`
    : `Groupe « ${group} » : cette session seule (le terminal ne l'a pas située dans une fenêtre).`
}

async function setName($: any, name: string) {
  const clean = name.trim()
  if (!clean || clean === S.name) return
  S.pendingName = clean
  S.name = clean
  await writeEntry($)
}

async function showStatus($: any) {
  const parts: string[] = []
  if (S.rolesDir) {
    if (!S.fiche) parts.push(S.role ? `⚠ rôle « ${S.role} » : fiche introuvable` : '⚠ pas de rôle : /role')
    else {
      const twin = await twinOf($, S.fiche.name)
      parts.push(twin ? `⚠ rôle « ${S.fiche.name} » tenu aussi par « ${who(twin)} »` : `rôle : ${S.fiche.name}`)
    }
  }
  if (S.group) parts.push(`groupe : ${S.group}`)
  const others = (await waitingList($)).filter(one => one.sid !== S.sid)
  if (others.length) parts.push(`⏳ ${others.length} t'attend${others.length > 1 ? 'ent' : ''} : /sessions`)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

async function tick($: any) {
  const now = await $.clock.now()
  const sid = await $.session.id()
  if (sid !== S.sid) {
    S.sid = sid
    S.transcript = (await $.session.info()).transcriptPath ?? ''
  }
  if (S.pendingName) {
    await $.command.run({ command: 'rename', args: S.pendingName }).catch((err: any) => $.ui.toast(`session : /rename refusé (${String(err)})`))
    if ((await lastTitle($, S.transcript, CHUNK)) === S.pendingName) S.pendingName = undefined
  }
  if (now - S.termAt > TERM_MS) {
    S.term = await where($).catch(() => S.term)
    S.termAt = now
    if (!S.pendingName) S.name = (await lastTitle($, S.transcript, CHUNK)) ?? S.name
  }
  await refreshFiche($)
  await syncGroup($)
  await writeEntry($)
  await showStatus($)
  await deliverMail($)
}

// ---------- Ouvrir, aller, fermer ----------

function quoted(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function resumeCommand(entry: Entry) {
  return `claude --resume ${entry.sid}`
}

async function focus($: any, entry: Entry) {
  if (!entry.term) return `« ${who(entry)} » : fenêtre inconnue. Pour la reprendre ailleurs : cd ${entry.cwd} && ${resumeCommand(entry)}`
  try {
    await terminal($, 'focus', entry.term.place)
    return `« ${who(entry)} » au premier plan.`
  } catch (err: any) {
    return `Impossible d'atteindre l'onglet de « ${who(entry)} » : ${err?.message ?? err}`
  }
}

// Rouvre des sessions fermées : en onglets dans la fenêtre vivante de leur
// groupe s'il y en a une, sinon dans une nouvelle fenêtre.
async function reopen($: any, list: Entry[]): Promise<string> {
  if (!list.length) return 'Rien à rouvrir.'
  const now = await $.clock.now()
  const group = list[0]!.group
  const host = group ? (await entries($)).find(one => one.group === group && isAlive(one, now) && one.term) : undefined
  const tabs = list.map(one => ({ cwd: one.cwd, command: resumeCommand(one) }))
  try {
    await terminal($, 'open', { near: host?.term?.place ?? null, title: group ?? null, tabs })
  } catch (err: any) {
    return `Échec de l'ouverture (${err?.message ?? err}). À la main : ${list.map(one => `cd ${one.cwd} && ${resumeCommand(one)}`).join(' ; ')}`
  }
  return host ? `Rouvert dans la fenêtre « ${group} » : ${list.map(who).join(', ')}.` : `Rouvert dans une nouvelle fenêtre : ${list.map(who).join(', ')}.`
}

async function members($: any, group: string): Promise<Entry[]> {
  return (await entries($))
    .filter(one => one.group === group)
    .sort((a, b) => (a.term?.order ?? 99) - (b.term?.order ?? 99))
}

async function openGroup($: any, group: string) {
  const now = await $.clock.now()
  const all = await members($, group)
  if (!all.length) return `Pas de groupe « ${group} ».`
  const closed = all.filter(one => !isAlive(one, now))
  if (closed.length) return reopen($, closed)
  return focus($, all[0]!)
}

// Ouverte : son onglet passe au premier plan. Fermée ou perdue : rouverte.
async function goTo($: any, entry: Entry) {
  const now = await $.clock.now()
  return isAlive(entry, now) ? focus($, entry) : reopen($, [entry])
}

// Ferme les onglets du groupe (cette session en dernier) ; refuse si un autre membre travaille.
async function closeGroup($: any, isForced: boolean) {
  if (!S.group) return 'Cette session n\'a pas de groupe : /moi pour lui en donner un.'
  const now = await $.clock.now()
  const alive = (await members($, S.group)).filter(one => isAlive(one, now) && one.sid !== S.sid)
  const busy = alive.filter(one => one.busy)
  if (busy.length && !isForced) {
    return `Refusé : au travail dans « ${S.group} » : ${busy.map(who).join(', ')}. /group close --force pour fermer quand même.`
  }
  for (const one of alive) {
    await $.fs.write(entryPath(one.sid), JSON.stringify({ ...one, closedAt: now }))
    if (one.term) await terminal($, 'close', one.term.place).catch(() => undefined)
  }
  await writeEntry($, now)
  if (S.term) void terminal($, 'close', S.term.place).catch(() => undefined)
  return `Groupe « ${S.group} » fermé.`
}

async function isStopping($: any): Promise<boolean> {
  try {
    const out = await $.process.run(['systemctl', 'is-system-running'], { timeoutMs: 2000 })
    return out.stdout.trim() === 'stopping'
  } catch {
    return true
  }
}

// ---------- Textes (sans écran) ----------

async function cardText($: any) {
  return [
    `Nom : ${S.name ?? '(aucun)'}`,
    `Rôle : ${S.fiche ? `${S.fiche.name} (${S.fiche.path})` : S.role ? `${S.role} (fiche introuvable)` : '(aucun)'}`,
    `Groupe : ${S.group ?? '(aucun)'}`,
    `Profil : ${S.profile} · id ${S.sid}${S.term ? ` · onglet ${S.term.order + 1} de sa fenêtre` : ''}`,
  ].join('\n')
}

// Les sessions par groupe, filtrées par nom, rôle, groupe ou dossier.
async function grouped($: any, typed: string): Promise<[string, Entry[]][]> {
  const now = await $.clock.now()
  const wanted = key(typed.trim())
  const all = (await entries($)).filter(one => !wanted ||
    [one.name, one.role, one.group, one.cwd].some(field => field && key(field).includes(wanted)))
  const byGroup = new Map<string, Entry[]>()
  for (const one of all) byGroup.set(one.group ?? '', [...(byGroup.get(one.group ?? '') ?? []), one])
  const order = (a: Entry, b: Entry) =>
    Number(isAlive(b, now)) - Number(isAlive(a, now)) || (a.term?.order ?? 99) - (b.term?.order ?? 99) || b.at - a.at
  return [...byGroup.entries()]
    .sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b, 'fr'))
    .map(([group, list]) => [group, list.sort(order)])
}

async function listText($: any, typed: string) {
  const now = await $.clock.now()
  const waiting = (await waitingList($)).filter(one => one.sid !== S.sid)
  const head = waiting.length ? `T'attendent :\n${waiting.map(one => `- ${who(one)} · ${stateOf(one, now)}`).join('\n')}\n\n` : ''
  return head + (await grouped($, typed)).map(([group, list]) =>
    `${group || 'sans groupe'} :\n${list.map(one => `- ${who(one)}${one.role && one.role !== one.name ? ` (rôle ${one.role})` : ''} · ${stateOf(one, now)} · ${one.cwd}`).join('\n')}`,
  ).join('\n\n') || 'Aucune session.'
}

// ---------- Panneaux ----------

async function closePane($: any, id: string) {
  await $.ui.close({ id })
  await update($, filter, () => '')
  await update($, view, () => 'card')
}

async function pickRole($: any, pane: string, name: string) {
  await closePane($, pane)
  const text = await chooseRole($, name)
  if (text) $.ui.toast(text.split('\n')[0])
}

async function pickGroup($: any, name: string) {
  const clean = name.trim()
  if (!clean) return
  await closePane($, CARD)
  $.ui.toast(await setGroup($, clean))
}

async function leaveGroup($: any) {
  await closePane($, CARD)
  $.ui.toast(await setGroup($, undefined))
}

async function rename($: any, name: string) {
  await setName($, name)
  $.ui.toast(`Nom : ${name.trim()}`)
}

async function pickSession($: any, entry: Entry) {
  await $.ui.close({ id: LIST })
  await update($, search, () => '')
  $.ui.toast(await goTo($, entry))
}

async function pickGroupRow($: any, group: string) {
  await $.ui.close({ id: LIST })
  await update($, search, () => '')
  $.ui.toast(await openGroup($, group))
}

// Le choix d'un rôle, dans le panneau /role ou dans /session.
async function rolePicker($: any, e: any, pane: string) {
  const { Box, Text, Input, Button } = $.ui.resolve(e)
  const typed = await read($, filter)
  const all = await roles($)
  const shown = all.filter(one => key(one).includes(key(typed)))
  const room = Math.max(1, (e.viewport?.rows ?? 24) - 7)
  const isNew = typed.trim() && !all.some(one => key(one) === key(typed.trim()))
  return (
    <Box flexDirection="column">
      <Text dimColor>{S.fiche ? `Rôle actuel : ${S.fiche.name}` : 'Pas de rôle'}{S.rolesDir ? ` · ${S.rolesDir}` : ' · aucun dossier .claude/roles'}</Text>
      <Input key="role" label="Rôle : " placeholder="filtrer, ou nom d'un nouveau rôle" autoFocus submitLabel={isNew ? 'créer' : 'prendre'}
        value={typed}
        onInput={(value: string) => void update($, filter, () => value)}
        onSubmit={(value: string) => void pickRole($, pane, shown.length === 1 && !isNew ? shown[0]! : value)} />
      {shown.slice(0, room).map(one => (
        <Button key={`role:${one}`} plain onPress={() => pickRole($, pane, one)}>
          {one}{S.fiche && key(S.fiche.name) === key(one) ? <Text dimColor> (actuel)</Text> : ''}
        </Button>
      ))}
      {shown.length > room && <Text dimColor>… {shown.length - room} autres : tape pour filtrer</Text>}
      {isNew && <Text color="warning">Entrée : créer la fiche « {typed.trim()} »</Text>}
    </Box>
  )
}

async function groupPicker($: any, e: any) {
  const { Box, Text, Input, Button } = $.ui.resolve(e)
  const typed = await read($, filter)
  const now = await $.clock.now()
  const all = await entries($)
  const groups = [...new Set(all.map(one => one.group).filter((one): one is string => !!one))].sort((a, b) => a.localeCompare(b, 'fr'))
  const shown = groups.filter(one => key(one).includes(key(typed)))
  const isNew = typed.trim() && !groups.some(one => key(one) === key(typed.trim()))
  return (
    <Box flexDirection="column">
      <Text dimColor>{S.group ? `Groupe actuel : ${S.group}` : 'Pas de groupe'} · le groupe s'applique à toute la fenêtre</Text>
      <Input key="group" label="Groupe : " placeholder="filtrer, ou nom d'un nouveau groupe" autoFocus submitLabel={isNew ? 'créer' : 'rejoindre'}
        value={typed}
        onInput={(value: string) => void update($, filter, () => value)}
        onSubmit={(value: string) => void pickGroup($, shown.length === 1 && !isNew ? shown[0]! : value)} />
      {shown.map(one => {
        const alive = all.filter(entry => entry.group === one && isAlive(entry, now)).length
        return (
          <Button key={`group:${one}`} plain onPress={() => pickGroup($, one)}>
            {one}<Text dimColor> · {alive} ouverte(s){S.group === one ? ' (actuel)' : ''}</Text>
          </Button>
        )
      })}
      {S.group && <Button key="group:-" plain onPress={() => leaveGroup($)}>(aucun groupe)<Text dimColor> · sortir la fenêtre de « {S.group} »</Text></Button>}
      {isNew && <Text color="warning">Entrée : créer le groupe « {typed.trim()} »</Text>}
    </Box>
  )
}

async function cardPane($: any, e: any) {
  const { Box, Text, Input, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      <Input key="name" label="Nom : " value={S.name ?? ''} placeholder="nom de la session" autoFocus submitLabel="renommer"
        onSubmit={(value: string) => void rename($, value)} />
      <Button key="to-role" plain onPress={() => update($, view, () => 'role')}>
        Rôle : {S.fiche?.name ?? S.role ?? '(aucun)'}<Text dimColor>  ▸ changer</Text>
      </Button>
      <Button key="to-group" plain onPress={() => update($, view, () => 'group')}>
        Groupe : {S.group ?? '(aucun)'}<Text dimColor>  ▸ changer</Text>
      </Button>
      <Text dimColor>Profil {S.profile} · {S.cwd}{S.term ? ` · onglet ${S.term.order + 1}` : ''} · id {S.sid.slice(0, 8)}</Text>
      <Text dimColor>/sessions : toutes les sessions · Échap : fermer</Text>
    </Box>
  )
}

async function listPane($: any, e: any) {
  const { Box, Text, Input, Button } = $.ui.resolve(e)
  const typed = await read($, search)
  const now = await $.clock.now()
  const groups = await grouped($, typed)
  // La liste tient dans le panneau, une ligne par entrée : les flèches passent
  // alors d'une ligne à l'autre au lieu de faire défiler le corps.
  const room = Math.max(3, (e.props?.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - 4) - 3)
  const width = Math.max(20, (e.props?.bodyColumns ?? 80) - 2)
  const cut = (head: string, tail: string) => tail.slice(0, Math.max(0, width - head.length))
  const rows: any[] = []
  let hidden = 0
  const waiting = (await waitingList($)).filter(one => one.sid !== S.sid &&
    (!typed.trim() || [one.name, one.role, one.group, one.cwd].some(field => field && key(field).includes(key(typed.trim())))))
  const first: Entry | undefined = waiting[0] ?? groups.flatMap(([, list]) => list).find(one => one.sid !== S.sid)
  if (waiting.length) {
    rows.push(<Text key="w:-" bold color="warning">T'attendent ({waiting.length})</Text>)
    for (const one of waiting) {
      if (rows.length >= room) { hidden++; continue }
      const head = `  ${who(one)}`
      rows.push(
        <Button key={`w:${one.sid}`} plain onPress={() => pickSession($, one)}>
          {head}<Text dimColor>{cut(head, `  ${stateOf(one, now)}${one.group ? ` · ${one.group}` : ''}`)}</Text>
        </Button>,
      )
    }
  }
  for (const [group, list] of groups) {
    const alive = list.filter(one => isAlive(one, now)).length
    if (rows.length < room) {
      rows.push(group
        ? <Button key={`g:${group}`} plain onPress={() => pickGroupRow($, group)}>
            <Text bold>{group}</Text><Text dimColor>{cut(group, ` · ${alive} ouverte(s), ${list.length - alive} fermée(s)`)}</Text>
          </Button>
        : <Text key="g:-" bold dimColor>sans groupe</Text>)
    }
    for (const one of list) {
      if (rows.length >= room) { hidden++; continue }
      const head = `  ${who(one)}`
      const tail = `${one.role && one.role !== one.name ? ` (rôle ${one.role})` : ''}  ${stateOf(one, now)}${one.sid === S.sid ? ' · ici' : ''} · ${one.cwd.replace(/^\/data\/(missions\/)?/, '')}`
      rows.push(
        <Button key={`s:${one.sid}`} plain onPress={() => pickSession($, one)}>
          {head}<Text dimColor>{cut(head, tail)}</Text>
        </Button>,
      )
    }
  }
  return (
    <Box flexDirection="column">
      <Input key="search" label="Chercher : " placeholder="nom, rôle, groupe ou dossier" autoFocus value={typed}
        onInput={(value: string) => void update($, search, () => value)}
        onSubmit={() => void (first && pickSession($, first))} />
      {rows}
      {hidden > 0 && <Text dimColor>… {hidden} autres : tape pour filtrer</Text>}
      <Text dimColor>{cut('', '↑↓ choisir · Entrée : aller (rouvrir si fermée) · Échap : fermer')}</Text>
    </Box>
  )
}

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.home = (await $.env.get('HOME')) ?? ''
    S.base = `${S.home}/.local/state/claude-pool`
    S.sid = await $.session.id()
    S.cwd = await $.session.root()
    S.profile = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${S.home}/.claude`).replace(/^.*\/\.claude-?/, '') || 'claude'
    S.transcript = (await $.session.info()).transcriptPath ?? ''
    S.rolesDir = await findRolesDir($)
    const args = await launchArgs($)
    S.isOneShot = args.includes('-p') || args.includes('--print')
    await loadIdentity($)
    await $.command.register({ name: 'moi', description: 'Cette session : nom, rôle, groupe (voir, modifier)' })
    await $.command.register({ name: 'sessions', description: 'Toutes les sessions : chercher, aller à l\'une, rouvrir', argumentHint: '[recherche]' })
    await $.command.register({ name: 'role', description: 'Le rôle de cette session : /role <nom>, ou /role pour choisir', argumentHint: '<nom>' })
    await $.command.register({ name: 'group', description: 'Le groupe de cette fenêtre : /group <nom> | open <nom> | close [--force] | - (aucun)', argumentHint: '[<nom> | open <nom> | close | -]' })
    await $.tool.register({
      name: WRITE_TOOL,
      isDeferred: false,
      description: 'Écrit à une autre session Claude Code de ce poste, désignée par son nom ou son rôle (ceux de /sessions), même fermée : '
        + 'le message attend dans sa boîte et elle le lit comme un tour dès qu\'elle est ouverte et libre. reveiller: true rouvre une session fermée pour qu\'elle le lise tout de suite. '
        + 'À préférer à SendMessage dès que la destinataire peut être fermée.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Nom ou rôle de la session destinataire (ex. « backend »)' },
          message: { type: 'string', description: 'Le message, lisible sans le contexte de cette session' },
          reveiller: { type: 'boolean', description: 'Rouvrir la destinataire si elle est fermée (défaut : non, elle lira à sa réouverture)' },
        },
        required: ['to', 'message'],
      },
    })
    await tick($)
    $.clock.every(BEAT_MS, () => void tick($).catch(() => undefined))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    S.doneAt = undefined
    S.askingSince = undefined
    await refreshFiche($).catch(() => undefined)
    return next(e)
  })

  // Une autorisation demandée : la session attend peut-être une personne.
  on('tool.check', async ($, e, next) => {
    const out = await next(e)
    if (out.decision === 'ask' && !S.askingSince) {
      S.askingSince = await $.clock.now()
      await writeEntry($).catch(() => undefined)
    }
    return out
  })

  // Un outil qui part : l'autorisation est donnée. Une question ou un plan
  // posés à la personne : la session l'attend jusqu'à la réponse.
  on('tool.call', async ($, e, next) => {
    const isAsking = e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode'
    S.askingSince = isAsking ? await $.clock.now() : undefined
    await writeEntry($).catch(() => undefined)
    const out = await next(e)
    if (isAsking) {
      S.askingSince = undefined
      await writeEntry($).catch(() => undefined)
    }
    return out
  })

  on('tool.run', { tool: 'mcp__session__ecrire' as any }, async ($, e: any) => {
    try {
      return { result: await sendMail($, String(e.to ?? ''), String(e.message ?? ''), e.reveiller === true) }
    } catch (err: any) {
      return { deny: err?.message ?? String(err) }
    }
  })

  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    await refreshFiche($)
    if (!S.fiche) return out
    const files = (out.instructionFiles ?? e.instructionFiles ?? []).filter((one: any) => one.path !== S.fiche!.path)
    return { ...out, instructionFiles: [...files, { path: S.fiche.path, kind: 'user', content: ficheText() }] }
  })

  // Au travail : un tour de la session elle-même (pas d'un sous-agent) est en cours.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      S.busy = true
      await writeEntry($).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      S.busy = false
      S.askingSince = undefined
      S.doneAt = e.reason === 'aborted' ? undefined : await $.clock.now()
      await writeEntry($).catch(() => undefined)
    }
    return out
  })

  // Fermée : /exit, /clear, une reprise ailleurs, ou un signal hors extinction de
  // la machine. Pendant une extinction (ou si on ne peut pas le savoir), elle
  // reste « perdue » : ouverte à l'arrêt, à rouvrir.
  on('session.end', async ($, e, next) => {
    const isShutdown = e.reason === 'other' && (await isStopping($))
    await writeEntry($, isShutdown ? undefined : await $.clock.now()).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (S.fiche || !S.rolesDir || e.props.hasSurvey) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color="warning">Pas de rôle : /role pour en choisir un, /moi pour tout voir</Text>
  })

  on('command.run', { command: 'moi' }, async $ => {
    await refreshFiche($)
    await update($, view, () => 'card')
    const opened = await $.ui.open({ id: CARD, title: 'Cette session', focus: true, closeOnEscape: true })
    if (opened.isPlaced) return { text: 'Fiche de la session ouverte (Échap pour fermer).', isTextDisplayOnly: true }
    return { text: await cardText($) }
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    await update($, search, () => e.args.trim())
    const opened = await $.ui.open({ id: LIST, title: 'Sessions', focus: true, closeOnEscape: true })
    if (opened.isPlaced) return { text: 'Liste des sessions ouverte (Échap pour fermer).', isTextDisplayOnly: true }
    return { text: await listText($, e.args) }
  })

  // /role seul : le choix en panneau. /role <nom> : ce rôle, ou créer sa fiche.
  on('command.run', { command: 'role' }, async ($, e) => {
    await refreshFiche($)
    const asked = e.args.trim()
    if (!asked) {
      const opened = await $.ui.open({ id: ROLE_PANE, title: 'Rôle de cette session', focus: true, closeOnEscape: true })
      if (opened.isPlaced) return { text: 'Choisis ou tape un rôle (Échap pour fermer).', isTextDisplayOnly: true }
      return { text: S.fiche ? `Rôle « ${S.fiche.name} » (${S.fiche.path}) :\n\n${S.fiche.text}` : `Pas de rôle.\n\n${await rolesText($)}` }
    }
    const text = await chooseRole($, asked)
    return S.fiche && key(S.fiche.name) === key(asked) ? { text, context: [ficheText()] } : { text }
  })

  on('command.run', { command: 'group' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    S.term = await where($).catch(() => undefined)
    S.termAt = await $.clock.now()
    await syncGroup($)
    if (!word) return { text: S.group ? `Groupe « ${S.group} » :\n\n${await listText($, S.group)}` : 'Pas de groupe : /group <nom> nomme cette fenêtre.' }
    if (word === 'open') return { text: arg ? await openGroup($, arg) : 'Lequel ? /group open <nom>' }
    if (word === 'close') return { text: await closeGroup($, arg === '--force') }
    if (word === '-') return { text: await setGroup($, undefined) }
    return { text: await setGroup($, e.args.trim()) }
  })

  // « /role h… », « /group open h… » : les noms connus, espaces compris.
  on('prompt.autocomplete', async ($, e, next) => {
    const out = await next(e)
    const before = e.text.slice(0, e.cursor)
    const found = /^\/(role|group open|group) (.*)$/.exec(before)
    if (!found) return out
    const typed = found[2] ?? ''
    const options = found[1] === 'role'
      ? await roles($)
      : [...new Set((await entries($)).map(one => one.group).filter((one): one is string => !!one))]
    const mine = options
      .filter(one => key(one).startsWith(key(typed)) && key(one) !== key(typed))
      .map(one => ({ text: one.slice(typed.length - e.token.length), label: one, description: found[1] === 'role' ? 'rôle' : 'groupe' }))
    return { suggestions: [...out.suggestions, ...mine] }
  })

  on('ui.render', { component: 'Pane', requestId: ROLE_PANE }, async ($, e) => rolePicker($, e, ROLE_PANE))

  on('ui.render', { component: 'Pane', requestId: CARD }, async ($, e) => {
    const current = await read($, view)
    if (current === 'role') return rolePicker($, e, CARD)
    if (current === 'group') return groupPicker($, e)
    return cardPane($, e)
  })

  on('ui.render', { component: 'Pane', requestId: LIST }, async ($, e) => listPane($, e))
}

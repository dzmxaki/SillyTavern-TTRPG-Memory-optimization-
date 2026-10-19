import { eventSource, event_types, chat, chat_metadata, generateRaw, saveSettingsDebounced, saveMetadata, getCurrentChatId, getRequestHeaders, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../script.js';
import { ToolManager } from '../../tool-calling.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { loadWorldInfo, saveWorldInfo, createWorldInfoEntry, METADATA_KEY } from '../../world-info.js';
import { hideChatMessageRange } from '../../chats.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { escapeHtml } from '../../utils.js';

const MODULE_NAME = 'ttrpg_memory';
const TAG = 'TTRPG';
const TIMELINE = ['past', 'present', 'futureLocal', 'futureGlobal'];
const PLANS = ['futureLocal', 'futureGlobal'];
const KIND_BY_FIELD = { past: 'past', present: 'present', futureLocal: 'future_local', futureGlobal: 'future_global' };
const FIELD_BY_KIND = Object.fromEntries(Object.entries(KIND_BY_FIELD).map(([k, v]) => [v, k]));
FIELD_BY_KIND.future = 'futureGlobal'; // legacy single "future" entry
const ORDER = { past: 100, present: 101, futureLocal: 102, futureGlobal: 103 };
const PLAN_WINDOW_MESSAGES = 30;
const COMPRESSED_FLAG = 'ttrpg_compressed';

const TIMELINE_HEADERS = {
    past: '[Произошло — сжатая хронология прошлых событий]',
    present: '[Происходит — текущая сцена и состояние мира]',
    futureLocal: '[Будущее, локальный сюжет — скрытые планы Мастера на ближайшие сцены. Они могут меняться по ходу игры. Не раскрывай их игроку напрямую]',
    futureGlobal: '[Будущее, глобальный сюжет — скрытая основная арка Мастера. Меняется редко. Не раскрывай её игроку напрямую]',
};

const defaultPrompt = `You are the memory keeper of a tabletop roleplaying game (TTRPG). Your job is to compress the chat log into a compact lorebook so the game master model can keep playing with a short context.

You receive: (1) the current lorebook, (2) the new chat messages since the last compression.
Return the UPDATED lorebook as a single JSON object and nothing else.

JSON format:
{
  "past": "string",
  "present": "string",
  "futureLocal": "string",
  "futureGlobal": "string",
  "entities": [
    { "type": "character | location | faction | item | other", "name": "string", "keys": ["trigger word", "..."], "content": "string" }
  ]
}

Rules:
- "past" (what happened): rewrite the old "past" text together with the events that are no longer current. Compress hard: facts, outcomes and consequences only, no atmosphere or prose. Compress older events more than recent ones. A few short notes per event at most.
- "present" (what is happening now): the current scene, location, time, who is present, ongoing actions, immediate goals, open threats, party state. Remove only filler words and empty descriptions, keep the picture detailed and concrete.
- "futureLocal" (planned, near term): the game master's hidden plans for the next scenes: upcoming events, encounters, NPC intentions, foreshadowing. Revise the old plans: drop what already happened or became obsolete, adapt the rest to what the players did, add new plot threads. Plans must stay flexible and surprising, do not repeat a puzzle the players already solved.
- "futureGlobal" (planned, main arc): the hidden big picture: the main antagonist, the final goal, long-term secrets. Change it rarely and carefully. The game master steers toward the goal, the players change the path, not the goal.
- "entities": one entry per important character, location, faction or item that is new or changed. Return ONLY new or changed entities, unchanged ones are kept automatically. Content must be a short summary (appearance in a few words, role, attitude to the party, current state, inventory, secrets). Keys are the names and aliases that should trigger the entry. To remove an entity set "content" to an empty string.
- Style: the text is read only by another language model, never by a human. Ignore human readability completely and minimize length: telegraphic notes, no full sentences, no articles or filler words, use symbols and abbreviations (→ = + ; / HP lvl etc). Keep it unambiguous for an LLM: keep names exact and do not merge different facts. Short style must not drop facts, it only drops words.
- Write in the same language as the chat. Do not invent facts that are not in the lorebook or the chat. Never put atmosphere descriptions or long quotes into any field.`;

const defaultPlanPrompt = `You are the story planner of a tabletop roleplaying game (TTRPG). You maintain the game master's HIDDEN plans: "futureLocal" (next few scenes) and "futureGlobal" (main arc).

You receive the current lorebook (past, present, plans) and the latest chat messages. Check what the players did and whether any plan was fulfilled, broken, made obsolete or can be developed further.

Return a single JSON object and nothing else:
{ "changed": true | false, "futureLocal": "string", "futureGlobal": "string" }

Rules:
- If nothing in the plans needs to change, return {"changed": false, "futureLocal": "", "futureGlobal": ""}.
- If something changed, return the FULL updated text of both fields (copy a field unchanged if it does not need editing).
- futureLocal: remove fulfilled or obsolete points, adapt the rest to the players' actions, add fresh hooks and complications. Keep it short and concrete.
- futureGlobal: change it only if the players' actions really altered the main arc. The game master steers toward the goal, the players change the path, not the goal.
- Plans must stay flexible: never lock the story onto a puzzle the players already solved. Do not reveal plans in narration style, write them as notes.
- Style: the plans are read only by another language model, never by a human. Ignore human readability and minimize length: telegraphic notes, no full sentences or filler words, symbols and abbreviations are welcome (→ = + ; /). Keep names exact and the meaning unambiguous.
- Write in the same language as the chat. Do not invent facts that are not in the lorebook or the chat.`;

const defaultDicePrompt = `[Dice rules]
You are the game master. When the outcome of a player's action is uncertain and failure would make the story more interesting, call the RollDice tool instead of deciding the result yourself.
- Roll for: attacks, skill checks, saving throws and risky actions. Do not roll for trivial or impossible actions, or for plain conversation without pressure.
- Decide the difficulty (DC) BEFORE rolling and pass it as "dc": 10 easy, 15 medium, 20 hard, 25 very hard.
- Build the expression from the character's modifier, for example "1d20+5". If the modifier is unknown, use "1d20". Use mode "advantage" or "disadvantage" only when the circumstances clearly help or hinder the player.
- Never invent, change or ignore a roll result. Narrate strictly according to it. A natural 20 or a natural 1 deserves an especially dramatic outcome.
- Roll once per uncertain action. Roll damage separately after a hit. Do not ask the player to roll unless they ask to.
- Keep the mechanics short in the narration: mention the roll in a few words, then describe what happens.`;

const defaultSettings = {
    diceTool: true,
    dicePrompt: defaultDicePrompt,
    preview: true,
    planInterval: 5,
    maxTokens: 4000,
    prompt: defaultPrompt,
    planPrompt: defaultPlanPrompt,
};

let busy = false;

const DICE_TOOL_NAME = 'RollDice';

function formatRoll(result, reason) {
    const terms = result.terms.map(t => {
        if (t.flat !== undefined) return String(t.flat);
        const rolls = `[${t.rolls.join(', ')}]`;
        return t.kept.length === t.rolls.length ? `${t.term}${rolls}` : `${t.term}${rolls} kept [${t.kept.join(', ')}]`;
    }).join(' ; ');
    const parts = [`Roll${reason ? ` (${reason})` : ''}: ${result.expression}${result.mode !== 'normal' ? ` with ${result.mode}` : ''} -> ${terms} = ${result.total}`];
    if (result.dc !== undefined) parts.push(`vs DC ${result.dc}: ${result.success ? 'SUCCESS' : 'FAILURE'}`);
    if (result.critical === 'success') parts.push('NATURAL 20');
    if (result.critical === 'failure') parts.push('NATURAL 1');
    return parts.join(', ');
}

function registerDiceTool() {
    ToolManager.unregisterFunctionTool(DICE_TOOL_NAME);
    setExtensionPrompt(`${MODULE_NAME}_dice`, '', extension_prompt_types.IN_PROMPT, 0);

    const { diceTool, dicePrompt } = getSettings();
    if (!diceTool) return;

    // Without function calling the model cannot call the tool, so the rules would only confuse it.
    setExtensionPrompt(`${MODULE_NAME}_dice`, dicePrompt, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM, () => ToolManager.isToolCallingSupported());
    ToolManager.registerFunctionTool({
        name: DICE_TOOL_NAME,
        displayName: 'Roll Dice',
        description: 'Roll dice for a TTRPG check, attack, saving throw or damage. Returns the real rolled result. Use it whenever the outcome of an action is uncertain.',
        parameters: Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                expression: { type: 'string', description: 'Dice expression, e.g. "1d20+5", "2d6+3", "4d6dl1" (drop lowest), "2d20kh1" (keep highest).' },
                dc: { type: 'integer', description: 'Difficulty class to beat. The result will include success or failure.' },
                mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: 'Applies to a single d20. Default is normal.' },
                reason: { type: 'string', description: 'Short note on what is being rolled, e.g. "Stealth check".' },
            },
            required: ['expression'],
        }),
        action: async (args) => {
            if (!args?.expression) throw new Error('Missing expression');
            // Some models send numbers as strings ("15").
            const dc = Number.parseInt(args.dc, 10);
            const response = await fetch('/api/ttrpg/roll', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ expression: String(args.expression), dc: Number.isInteger(dc) ? dc : undefined, mode: args.mode || undefined }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Dice roll failed (${response.status})`);
            return formatRoll(data, args.reason);
        },
        formatMessage: (args) => `Rolling ${args?.expression ?? 'dice'}${args?.reason ? ` (${args.reason})` : ''}`,
    });
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

function setStatus(text) {
    $('#ttrpg_memory_status').text(text);
}

/**
 * Gets (or creates) the chat-bound lorebook.
 * @returns {Promise<string>} Lorebook name
 */
async function getChatBook() {
    const result = await getContext().executeSlashCommandsWithOptions('/getchatbook', { handleExecutionErrors: true });
    const name = String(result?.pipe ?? '').trim();
    if (!name) {
        throw new Error('Не удалось получить лорбук чата');
    }
    return name;
}

function isOurEntry(entry) {
    return typeof entry?.comment === 'string' && entry.comment.startsWith(`${TAG}:`);
}

function entityName(entry) {
    return entry.comment.split(':').slice(3).join(':');
}

function entryComment(kind, type, name) {
    return kind === 'entity' ? `${TAG}:entity:${type}:${name}` : `${TAG}:${kind}`;
}

function stripHeader(text) {
    return String(text ?? '').replace(/^\[[^\]\n]*\]\n/, '');
}

function findEntry(book, comment) {
    return Object.values(book.entries).find(e => e.comment === comment);
}

/**
 * Collects the current state of our lorebook entries.
 */
function readBookState(book) {
    const state = { past: '', present: '', futureLocal: '', futureGlobal: '', entities: [] };
    for (const entry of Object.values(book.entries).filter(isOurEntry)) {
        const [, kind, type] = entry.comment.split(':');
        if (kind === 'entity') {
            state.entities.push({ type, name: entityName(entry), keys: entry.key, content: entry.content });
        } else if (FIELD_BY_KIND[kind]) {
            state[FIELD_BY_KIND[kind]] = stripHeader(entry.content);
        }
    }
    return state;
}

function isToolMessage(message) {
    return Array.isArray(message?.extra?.tool_invocations);
}

/**
 * Whether the message still reaches the model. Tool results (dice rolls) are system messages,
 * but SillyTavern sends them anyway, so they count as visible until we compress them.
 */
function isVisibleToModel(message) {
    if (isToolMessage(message)) return !message.extra[COMPRESSED_FLAG];
    return !message.is_system;
}

/**
 * Returns messages the model still sees, with their chat indexes.
 */
function getVisibleMessages() {
    return chat.map((message, index) => ({ message, index })).filter(({ message }) => isVisibleToModel(message));
}

function formatMessages(items) {
    return items.map(({ message }) => `${message.name}: ${message.mes}`).join('\n\n');
}

function buildPrompt(state, items) {
    return `### CURRENT LOREBOOK\n${JSON.stringify(state, null, 2)}\n\n### NEW CHAT MESSAGES\n${formatMessages(items)}\n\n### TASK\nReturn the updated lorebook JSON now.`;
}

function buildPlanPrompt(state, items) {
    const { entities: _entities, ...lore } = state;
    return `### CURRENT LOREBOOK\n${JSON.stringify(lore, null, 2)}\n\n### LATEST CHAT MESSAGES\n${formatMessages(items)}\n\n### TASK\nReview the plans and return the JSON now.`;
}

function parseJson(raw) {
    const text = removeReasoningFromString(String(raw)).replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
        throw new Error('Модель не вернула JSON');
    }
    return JSON.parse(text.slice(start, end + 1));
}

function parseResponse(raw) {
    const data = parseJson(raw);

    const result = { entities: [] };
    for (const field of TIMELINE) {
        if (typeof data[field] !== 'string') {
            throw new Error(`В ответе нет поля "${field}"`);
        }
        result[field] = data[field].trim();
    }
    for (const e of Array.isArray(data.entities) ? data.entities : []) {
        if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
        result.entities.push({
            type: String(e.type || 'other').replace(/[^\p{L}\p{N}_-]/gu, '').toLowerCase() || 'other',
            name: e.name.trim().replace(/:/g, ' '),
            keys: [...new Set([e.name.trim(), ...(Array.isArray(e.keys) ? e.keys : [])].map(k => String(k).trim()).filter(Boolean))],
            content: typeof e.content === 'string' ? e.content.trim() : '',
        });
    }
    return result;
}

function parsePlanResponse(raw, state) {
    const data = parseJson(raw);
    if (data.changed !== true) {
        return null;
    }
    if (typeof data.futureLocal !== 'string' || typeof data.futureGlobal !== 'string') {
        throw new Error('В ответе нет полей futureLocal / futureGlobal');
    }
    return {
        futureLocal: data.futureLocal.trim(),
        // The main arc must not vanish by accident.
        futureGlobal: data.futureGlobal.trim() || state.futureGlobal,
    };
}

function renderPreview(result) {
    const section = (title, body) => `<h4>${escapeHtml(title)}</h4><pre>${escapeHtml(body || '—')}</pre>`;
    const entities = result.entities.map(e => `${e.content ? '' : '[удалить] '}${e.name} (${e.type}): ${e.content}`).join('\n\n');
    return `<div class="ttrpg_memory_preview">
        <h3>Предпросмотр лорбука</h3>
        ${section('Произошло', result.past)}
        ${section('Происходит', result.present)}
        ${section('Будущее: локальное', result.futureLocal)}
        ${section('Будущее: глобальное', result.futureGlobal)}
        ${section('Изменённые записи', entities)}
    </div>`;
}

function upsertEntry(book, comment, { keys, content, constant, order }) {
    let entry = findEntry(book, comment);
    if (!content) {
        if (entry) delete book.entries[entry.uid];
        return;
    }
    if (!entry) {
        entry = createWorldInfoEntry(null, book);
        if (!entry) throw new Error('Не удалось создать запись лорбука');
    }
    entry.comment = comment;
    entry.content = content;
    entry.key = keys;
    entry.constant = constant;
    entry.order = order;
    entry.disable = false;
}

function writeField(book, field, text) {
    const content = text ? `${TIMELINE_HEADERS[field]}\n${text}` : '';
    upsertEntry(book, entryComment(KIND_BY_FIELD[field]), { keys: [], content, constant: true, order: ORDER[field] });
}

async function applyResult(bookName, book, result) {
    for (const field of TIMELINE) {
        writeField(book, field, result[field]);
    }
    // Drop the legacy single "future" entry if it is still there.
    const legacy = findEntry(book, entryComment('future'));
    if (legacy) delete book.entries[legacy.uid];

    for (const e of result.entities) {
        // Replace an entity regardless of the type the model picked this time.
        const existing = Object.values(book.entries).find(x => isOurEntry(x) && x.comment.startsWith(`${TAG}:entity:`) && entityName(x).toLowerCase() === e.name.toLowerCase());
        const comment = existing ? existing.comment : entryComment('entity', e.type, e.name);
        upsertEntry(book, comment, { keys: e.keys, content: e.content, constant: false, order: 200 });
    }

    await saveWorldInfo(bookName, book, true);
}

function getMeta() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {};
    }
    return chat_metadata[MODULE_NAME];
}

/**
 * Remembers the current plans so the last revision can be rolled back, and moves the turn counter.
 */
async function rememberPlans(state) {
    const meta = getMeta();
    meta.backup = { futureLocal: state.futureLocal, futureGlobal: state.futureGlobal };
    meta.planMark = chat.length;
    await saveMetadata();
}

function getPlanMark() {
    return Math.min(Math.max(Number(getMeta().planMark) || 0, 0), chat.length);
}

function countPlanTurns() {
    return chat.slice(getPlanMark()).filter(m => m.is_user).length;
}

function setBusy(value) {
    busy = value;
    $('#ttrpg_memory_compress, #ttrpg_memory_wand').toggleClass('disabled', value);
}

/**
 * Compresses the visible chat into the chat-bound lorebook and hides the old messages.
 */
async function compressContext() {
    if (busy) return;
    if (!getCurrentChatId()) {
        toastr.warning('Откройте чат');
        return;
    }

    const items = getVisibleMessages();
    if (items.length < 2) {
        toastr.info('Нечего сжимать');
        return;
    }

    setBusy(true);
    const settings = getSettings();
    setStatus('Сжатие…');
    toastr.info('Сжимаю контекст…');

    try {
        const bookName = await getChatBook();
        const book = await loadWorldInfo(bookName);
        if (!book?.entries) throw new Error('Не удалось загрузить лорбук');

        const oldState = readBookState(book);
        const raw = await generateRaw({
            prompt: buildPrompt(oldState, items),
            systemPrompt: settings.prompt,
            responseLength: settings.maxTokens,
        });
        const result = parseResponse(raw);

        if (settings.preview) {
            const confirmed = await callGenericPopup(renderPreview(result), POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: 'Записать', cancelButton: 'Отмена' });
            if (!confirmed) {
                setStatus('Отменено');
                return;
            }
        }

        await applyResult(bookName, book, result);
        await rememberPlans(oldState);

        // Keep only the last character message (and anything after it) visible to the model.
        const lastAi = items.findLast(({ message }) => !message.is_user);
        if (lastAi && lastAi.index > 0) {
            // Hiding does not stop tool results from being sent, so flag them for the interceptor.
            // The flag is saved together with the chat by hideChatMessageRange.
            for (const { message } of items.filter(i => i.index < lastAi.index && isToolMessage(i.message))) {
                message.extra[COMPRESSED_FLAG] = true;
            }
            await hideChatMessageRange(0, lastAi.index - 1, false);
        }

        setStatus(`Готово: скрыто сообщений — ${lastAi ? items.filter(i => i.index < lastAi.index).length : 0}`);
        toastr.success('Контекст сжат в лорбук');
    } catch (error) {
        console.error('[TTRPG Memory]', error);
        setStatus(`Ошибка: ${error.message}`);
        toastr.error(error.message, 'TTRPG Memory');
    } finally {
        setBusy(false);
    }
}

/**
 * Light auto-revision of the hidden plans ("Future") every N player turns.
 */
async function revisePlans() {
    const { planInterval, planPrompt, maxTokens } = getSettings();
    if (busy || planInterval <= 0 || !getCurrentChatId() || countPlanTurns() < planInterval) return;

    const bookName = chat_metadata[METADATA_KEY];
    if (!bookName) return;

    setBusy(true);
    try {
        const book = await loadWorldInfo(bookName);
        if (!book?.entries) return;

        const state = readBookState(book);
        if (!state.futureLocal && !state.futureGlobal) return;

        const mark = getPlanMark();
        const items = chat.slice(mark).map((message, i) => ({ message, index: mark + i }))
            .filter(({ message }) => isVisibleToModel(message)).slice(-PLAN_WINDOW_MESSAGES);

        // Advance the counter first so a failing API is not called again on every message.
        getMeta().planMark = chat.length;

        const raw = await generateRaw({
            prompt: buildPlanPrompt(state, items),
            systemPrompt: planPrompt,
            responseLength: maxTokens,
        });
        const plans = parsePlanResponse(raw, state);
        if (!plans || (plans.futureLocal === state.futureLocal && plans.futureGlobal === state.futureGlobal)) {
            await saveMetadata();
            setStatus('Планы проверены: изменений нет');
            return;
        }

        getMeta().backup = { futureLocal: state.futureLocal, futureGlobal: state.futureGlobal };
        writeField(book, 'futureLocal', plans.futureLocal);
        writeField(book, 'futureGlobal', plans.futureGlobal);
        await saveWorldInfo(bookName, book, true);
        await saveMetadata();

        setStatus('Планы обновлены');
        toastr.info('Планы Мастера обновлены. Нажмите, чтобы откатить.', 'TTRPG Memory', { onclick: () => rollbackPlans(), timeOut: 8000 });
    } catch (error) {
        console.error('[TTRPG Memory] plan revision failed', error);
        setStatus(`Ошибка ревизии планов: ${error.message}`);
        toastr.warning(error.message, 'TTRPG Memory: ревизия планов');
    } finally {
        setBusy(false);
    }
}

async function rollbackPlans() {
    if (busy) {
        toastr.info('Подождите, идёт сжатие или ревизия планов');
        return;
    }
    const backup = getMeta().backup;
    const bookName = chat_metadata[METADATA_KEY];
    if (!backup || !bookName) {
        toastr.info('Нечего откатывать');
        return;
    }

    setBusy(true);
    try {
        const book = await loadWorldInfo(bookName);
        if (!book?.entries) return;

        for (const field of PLANS) {
            writeField(book, field, backup[field]);
        }
        await saveWorldInfo(bookName, book, true);
        delete getMeta().backup;
        await saveMetadata();
        setStatus('Планы восстановлены');
        toastr.success('Планы возвращены к предыдущей версии');
    } catch (error) {
        console.error('[TTRPG Memory] plan rollback failed', error);
        toastr.error(error.message, 'TTRPG Memory');
    } finally {
        setBusy(false);
    }
}

/**
 * Generation interceptor: drops dice results that were already compressed into the lorebook.
 * @param {object[]} coreChat Prompt copy of the chat
 */
globalThis.ttrpgMemory_dropCompressedTools = function (coreChat) {
    for (let i = coreChat.length - 1; i >= 0; i--) {
        if (coreChat[i]?.extra?.[COMPRESSED_FLAG]) {
            coreChat.splice(i, 1);
        }
    }
};

function onMessageRendered(_messageId, type) {
    if (type === 'swipe' || type === 'impersonate') return;
    revisePlans();
}

function loadSettingsUi() {
    const settings = getSettings();
    $('#ttrpg_memory_preview').prop('checked', settings.preview).on('input', function () {
        settings.preview = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#ttrpg_memory_plan_interval').val(settings.planInterval).on('input', function () {
        settings.planInterval = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });
    $('#ttrpg_memory_max_tokens').val(settings.maxTokens).on('input', function () {
        settings.maxTokens = Math.max(500, Number($(this).val()) || defaultSettings.maxTokens);
        saveSettingsDebounced();
    });
    for (const [id, key, fallback] of [['ttrpg_memory_prompt', 'prompt', defaultPrompt], ['ttrpg_memory_plan_prompt', 'planPrompt', defaultPlanPrompt]]) {
        $(`#${id}`).val(settings[key]).on('input', function () {
            settings[key] = String($(this).val());
            saveSettingsDebounced();
        });
        $(`#${id}_restore`).on('click', () => {
            settings[key] = fallback;
            $(`#${id}`).val(fallback);
            saveSettingsDebounced();
        });
    }
    $('#ttrpg_memory_dice_tool').prop('checked', settings.diceTool).on('input', function () {
        settings.diceTool = !!$(this).prop('checked');
        saveSettingsDebounced();
        registerDiceTool();
    });
    $('#ttrpg_memory_dice_prompt').val(settings.dicePrompt).on('input', function () {
        settings.dicePrompt = String($(this).val());
        saveSettingsDebounced();
        registerDiceTool();
    });
    $('#ttrpg_memory_dice_prompt_restore').on('click', () => {
        settings.dicePrompt = defaultDicePrompt;
        $('#ttrpg_memory_dice_prompt').val(defaultDicePrompt);
        saveSettingsDebounced();
        registerDiceTool();
    });
    $('#ttrpg_memory_compress').on('click', () => compressContext());
    $('#ttrpg_memory_rollback').on('click', () => rollbackPlans());
}

export async function init() {
    const html = await renderExtensionTemplateAsync('ttrpg-memory', 'settings');
    $('#extensions_settings2').append(html);
    loadSettingsUi();
    registerDiceTool();

    const wandButton = $(`
        <div id="ttrpg_memory_wand" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-broom extensionsMenuExtensionButton"></div>
            <span>Очистить контекст</span>
        </div>`);
    $('#extensionsMenu').append(wandButton);
    wandButton.on('click', () => compressContext());

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ttrpg-compress',
        callback: async () => {
            await compressContext();
            return '';
        },
        helpString: 'Сжимает историю чата в лорбук чата (Произошло / Происходит / Будущее) и скрывает старые сообщения от модели.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ttrpg-plans-rollback',
        callback: async () => {
            await rollbackPlans();
            return '';
        },
        helpString: 'Возвращает локальный и глобальный планы к версии до последней ревизии.',
    }));
}

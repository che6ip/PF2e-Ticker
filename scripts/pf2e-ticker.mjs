/**
 * PF2e: Ticker — периодический урон и лечение вне боя.
 *
 * Каждые 6 секунд игрового времени (game.time.worldTime) модуль:
 * - наносит persistent damage и бросает автоматический flat check на восстановление;
 * - применяет fast healing / regeneration.
 * Если время промотали вперёд, обрабатываются все пропущенные тики.
 * В бою тикер не работает: там этим занимается PF2e.
 */

const MODULE_ID = "pf2e-ticker";
const BUILD = "1.6.0";
const TICK_SECONDS = 6;
const MAX_TICKS_PER_ADVANCE = 10000;

const DURATION_UNITS = {
  rounds: 6,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

let lastTickerTime = null;
let currentAdvanceEnd = null;
let processingQueue = Promise.resolve();
let ticking = false;
let capturedDamage = null;
let capturedRecovery = null;

/* -------------------------------------------------------------------------- */
/*  Стили                                                                      */
/* -------------------------------------------------------------------------- */

function ensureStylesheet() {
  try {
    const href = `modules/${MODULE_ID}/styles/pf2e-ticker.css`;
    const exists = [...document.querySelectorAll('link[rel="stylesheet"]')].some((link) =>
      (link.getAttribute("href") ?? "").includes(`${MODULE_ID}/styles/pf2e-ticker.css`)
    );
    if (exists) return;

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.pf2eTickerStyle = "";
    document.head.append(link);
  } catch (err) {
    console.warn(`${MODULE_ID} | Не удалось подключить стили`, err);
  }
}

ensureStylesheet();

/* -------------------------------------------------------------------------- */
/*  Перехват служебных сообщений                                               */
/* -------------------------------------------------------------------------- */

Hooks.on("preCreateChatMessage", (message) => {
  if (!ticking) return;
  const pf2e = message?.flags?.pf2e;
  if (!pf2e) return;

  // Карточка нанесённого/полученного урона или лечения.
  if (pf2e.appliedDamage) {
    const updates = pf2e.appliedDamage.updates ?? [];
    const hpUpdate = updates.find((update) => update.path === "system.attributes.hp.value");
    capturedDamage = {
      hpDelta: Number(hpUpdate?.value ?? 0),
      isHealing: Boolean(pf2e.appliedDamage.isHealing),
    };
    return;
  }

  // Проверка восстановления от persistent damage.
  if (pf2e.modifierName === "pd-recovery") {
    capturedRecovery = describeRecoveryCheck(message, pf2e);
  }
});

/**
 * Достаёт из карточки flat check итоговый бросок, DC и исход.
 */
function describeRecoveryCheck(message, pf2e) {
  const context = pf2e.context ?? {};
  const options = Array.isArray(context.options) ? context.options.map(String) : [];
  const totalOption = options.find((option) => /^check:total:-?\d+$/.test(option));
  const rollTotal = message?.rolls?.[0]?.total;
  const total = Number(
    Number.isFinite(rollTotal)
      ? rollTotal
      : totalOption
        ? totalOption.split(":").pop()
        : NaN
  );
  const dc = Number(context.dc?.value ?? context.dc ?? NaN);

  return {
    outcome: context.outcome ?? null,
    total: Number.isFinite(total) ? total : null,
    dc: Number.isFinite(dc) ? dc : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Карточки PF2e                                                              */
/* -------------------------------------------------------------------------- */

/** Класс PF2e DamageRoll (в PF2e он регистрируется в CONFIG.Dice.rolls). */
function getDamageRollClass() {
  return CONFIG.Dice?.rolls?.find((RollClass) => RollClass.name === "DamageRoll") ?? null;
}

/** Публикует дефолтную карточку урона от persistent damage. */
async function postPersistentDamageCard(actor, condition, roll) {
  const flavor = `<strong>${foundry.utils.escapeHTML(condition.name)}</strong>`;
  await roll.toMessage({
    speaker: CONFIG.ChatMessage.documentClass.getSpeaker({
      actor,
      token: getActorToken(actor),
    }),
    flavor,
    flags: {
      pf2e: { origin: { uuid: condition.uuid } },
    },
  });
}

/** Публикует дефолтную карточку лечения (fast healing / regeneration). */
async function postHealingCard(actor, source, value) {
  const DamageRollClass = getDamageRollClass();
  if (!DamageRollClass) return;

  const typeKey = source.type === "regeneration" ? "regeneration" : "fast-healing";
  const label = game.i18n.localize(
    `PF2E.Encounter.Broadcast.FastHealing.${typeKey}.ReceivedMessage`
  );
  const roll = new DamageRollClass(`{(${value})[healing]}`);
  await roll.evaluate();

  await ChatMessage.create(
    {
      flavor: `<div>${label}</div><div data-visibility="owner">${foundry.utils.escapeHTML(
        source.name
      )}</div>`,
      speaker: CONFIG.ChatMessage.documentClass.getSpeaker({
        actor,
        token: getActorToken(actor),
      }),
      rolls: [roll.toJSON()],
    },
    { messageMode: actor.hasPlayerOwner ? "public" : "gm" }
  );
}

/* -------------------------------------------------------------------------- */
/*  Вспомогательные функции                                                    */
/* -------------------------------------------------------------------------- */

function isTickerOwner() {
  const gm = game.users.activeGM;
  return gm ? gm.id === game.user.id : game.user.isGM;
}

/* -------------------------------------------------------------------------- */
/*  Диагностика: какая сборка загружена и что обработала                        */
/* -------------------------------------------------------------------------- */

/**
 * Пишем в world-setting сведения о загруженной сборке и последнем проматывании.
 * Это позволяет проверить, что именно загружено в клиенте активного GM.
 */
async function writeDiagnostics(patch = {}) {
  try {
    const all = game.settings.get(MODULE_ID, "diagnostics") ?? {};
    all[game.user.id] = {
      ...(all[game.user.id] ?? {}),
      user: game.user.name,
      build: BUILD,
      worldTime: Number(game.time.worldTime ?? 0),
      at: Date.now(),
      ...patch,
    };
    await game.settings.set(MODULE_ID, "diagnostics", all);
  } catch {
    // Диагностика не должна мешать работе тикера.
  }
}

function getItemActor(item) {
  const ActorClass = CONFIG.Actor.documentClass;
  if (item?.actor instanceof ActorClass) return item.actor;
  const parent = item?.parent;
  if (parent instanceof ActorClass) return parent;
  if (parent?.actor instanceof ActorClass) return parent.actor;
  return null;
}

function getActorToken(actor) {
  try {
    const tokens = actor.getActiveTokens(true, true);
    return tokens[0] ?? actor.token ?? actor.prototypeToken ?? null;
  } catch {
    return actor.token ?? actor.prototypeToken ?? null;
  }
}

function isDeadActor(actor) {
  const hp = actor?.attributes?.hp;
  if (!hp) return true;
  if (actor.isDead) return true;
  return hp.max > 0 && hp.value <= -hp.max;
}

function safeTest(rule) {
  try {
    return rule.test();
  } catch {
    return false;
  }
}

/** Все правила FastHealing / Regeneration на актёре. */
function getAllFastHealingRules(actor) {
  return (actor?.rules ?? []).filter(
    (rule) => rule.key === "FastHealing" && !rule.ignored && safeTest(rule)
  );
}

/** Время окончания эффекта, если у него есть длительность. */
function getEffectExpiryTime(item) {
  const duration = item?.system?.duration;
  const start = item?.system?.start;
  if (!duration || !start) return Infinity;
  if (duration.unit === "unlimited" || duration.unit === "encounter") return Infinity;

  const unit = DURATION_UNITS[duration.unit];
  if (!unit) return Infinity;

  const value = Number(duration.value ?? 0);
  if (!Number.isFinite(value)) return Infinity;

  return Number(start.value ?? 0) + value * unit;
}

/**
 * Реестр лечебных эффектов. PF2e с включённой автоматизацией (`removeEffects`)
 * удаляет истёкший эффект сразу при проматывании времени — возможно, раньше,
 * чем тикер обработает пропущенные тики. Реестр сохраняет данные эффекта,
 * чтобы дотикать его до момента окончания длительности.
 */
const healingRegistry = new Map();

function getActorKey(actor) {
  return actor?.uuid ?? actor?.id ?? "?";
}

/* -------------------------------------------------------------------------- */
/*  Регенерация: временное отключение уроном                                   */
/* -------------------------------------------------------------------------- */

/**
 * Регенерация перестаёт работать, если существо получает урон одного из типов
 * из `deactivatedBy` правила `FastHealing` (type: "regeneration").
 * Отключение длится до конца следующего хода существа: вне боя это один тик.
 */
const regenerationSuppression = new Map();
const combatRegenerationSuppression = new Map();
let currentTickTime = null;

function isRegenerationSuppressed(actor, source, tickTime) {
  if (source.type !== "regeneration") return false;
  const key = getActorKey(actor);
  const state = regenerationSuppression.get(key);
  if (!state) return false;
  if (tickTime >= state.until) {
    regenerationSuppression.delete(key);
    return false;
  }
  if (tickTime < state.from) return false;

  const deactivatedBy = source.deactivatedBy ?? [];
  if (deactivatedBy.length === 0) return false;
  for (const type of state.types) {
    if (deactivatedBy.includes(type)) return true;
  }
  return false;
}

function activeCombat() {
  return game.combats?.contents?.find((combat) => combat.started) ?? null;
}

/** Отключена ли регенерация в бою (до начала следующего хода существа). */
function isCombatRegenerationSuppressed(actor, deactivatedBy) {
  const state = combatRegenerationSuppression.get(getActorKey(actor));
  if (!state) return false;
  if (state.combatId !== activeCombat()?.id) return false;

  const types = (deactivatedBy ?? []).map((type) => String(type).toLowerCase());
  if (types.length === 0) return false;
  for (const type of state.types) {
    if (types.includes(type)) return true;
  }
  return false;
}

function recordCombatRegenerationDamage(actor, types) {
  const combat = activeCombat();
  if (!combat) return;

  const key = getActorKey(actor);
  const current = combatRegenerationSuppression.get(key);
  if (current && current.combatId === combat.id) {
    for (const type of types) current.types.add(type);
  } else {
    combatRegenerationSuppression.set(key, {
      combatId: combat.id,
      types: new Set(types),
    });
  }
}

function recordRegenerationDamage(actor, types, time) {
  if (!actor || types.size === 0) return;
  const key = getActorKey(actor);
  const now = Number(time ?? 0);
  const nextTick = Math.floor(now / TICK_SECONDS) * TICK_SECONDS + TICK_SECONDS;
  const until = nextTick + TICK_SECONDS;

  recordCombatRegenerationDamage(actor, types);

  const current = regenerationSuppression.get(key);
  if (current && until <= current.until) {
    for (const type of types) current.types.add(type);
    return;
  }
  regenerationSuppression.set(key, { from: nextTick, until, types: new Set(types) });
}

/** Типы урона из карточки применения урона PF2e. */
function damageTypesFromMessage(message) {
  const pf2e = message?.flags?.pf2e ?? {};
  const options = [
    ...(pf2e.context?.options ?? []),
    ...(pf2e.origin?.rollOptions ?? []),
  ].map(String);

  const types = new Set();
  for (const option of options) {
    const match = /^damage:type:(.+)$/.exec(option);
    if (match) types.add(match[1].toLowerCase());
  }
  return types;
}

/**
 * Патчим правило регенерации PF2e: в бою PF2e лечит её в начале хода,
 * независимо от deactivatedBy. Мы пропускаем лечение в начале хода,
 * если существо было ранено подходящим типом урона.
 */
function patchFastHealingRule() {
  try {
    const FastHealingClass = game.pf2e?.RuleElements?.builtin?.FastHealing;
    const proto = FastHealingClass?.prototype;
    if (!proto || proto.__pf2eTickerRegeneration) return;

    const original = proto.onUpdateEncounter;
    if (typeof original !== "function") return;

    proto.__pf2eTickerRegeneration = true;
    proto.onUpdateEncounter = async function (event) {
      if (this.type === "regeneration" && event?.event === "turn-start") {
        const actor = this.actor;
        if (actor && isCombatRegenerationSuppressed(actor, this.deactivatedBy)) {
          return;
        }
      }
      return original.call(this, event);
    };
  } catch (err) {
    console.warn(
      `${MODULE_ID} | Не удалось подключить деактивацию регенерации в бою`,
      err
    );
  }
}

// Ход существа начался (и PF2e уже попытался полечить регенерацией) — окно закончилось.
Hooks.on("pf2e.startTurn", (combatant) => {
  const actor = combatant?.actor;
  if (actor) combatRegenerationSuppression.delete(getActorKey(actor));
});

Hooks.on("updateCombat", (combat, changes) => {
  if (changes?.started !== false) return;
  for (const [key, state] of combatRegenerationSuppression) {
    if (state.combatId === combat.id) combatRegenerationSuppression.delete(key);
  }
});

Hooks.on("deleteCombat", (combat) => {
  for (const [key, state] of combatRegenerationSuppression) {
    if (state.combatId === combat.id) combatRegenerationSuppression.delete(key);
  }
});

function resolveActorByUuid(uuid) {
  if (!uuid) return null;
  try {
    const doc = fromUuidSync(uuid);
    if (doc instanceof CONFIG.Actor.documentClass) return doc;
    if (doc?.actor instanceof CONFIG.Actor.documentClass) return doc.actor;
  } catch {
    // Ниже попробуем найти по id.
  }
  const id = String(uuid).split(".").pop();
  return game.actors?.get(id) ?? null;
}

/** Типы урона из DamageRoll (используется при перехвате applyDamage). */
function damageTypesFromDamage(damage) {
  const types = new Set();
  for (const instance of damage?.instances ?? []) {
    const type = String(instance?.type ?? "").toLowerCase();
    if (type) types.add(type);
  }
  if (types.size === 0 && typeof damage?.formula === "string") {
    for (const match of damage.formula.matchAll(/\[([a-z][a-z-]*)\]/gi)) {
      const type = match[1].toLowerCase();
      if (type in (CONFIG.PF2E?.damageTypes ?? {})) types.add(type);
    }
  }
  return types;
}

/** Запоминаем урон на всех клиентах: в бою PF2e может лечить на любом из них. */
function reportRegenerationDamage(actor, types, time) {
  if (!actor || types.size === 0) return;

  recordRegenerationDamage(actor, types, time);

  // Если мы не активный GM, помечаем карточку урона — флаг разойдётся всем.
  if (!isTickerOwner()) void tagAppliedDamageMessage(actor, [...types]);
}

async function tagAppliedDamageMessage(actor, types) {
  try {
    const candidates = game.messages.contents.filter((message) => {
      const applied = message.flags?.pf2e?.appliedDamage;
      return (
        applied &&
        !applied.isHealing &&
        applied.uuid === actor.uuid &&
        Date.now() - Number(message.timestamp ?? 0) < 5000
      );
    });
    const message = candidates.at(-1);
    if (!message) return;
    await message.setFlag(MODULE_ID, "damageTypes", types);
  } catch {
    // Если пометить не удалось — просто не сообщим GM о типе урона.
  }
}

Hooks.on("createChatMessage", (message) => {
  const applied = message?.flags?.pf2e?.appliedDamage;
  if (!applied || applied.isHealing) return;

  const updates = applied.updates ?? [];
  const hpUpdate = updates.find(
    (update) => update.path === "system.attributes.hp.value"
  );
  if (!(Number(hpUpdate?.value ?? 0) > 0)) return;

  const types = damageTypesFromMessage(message);
  if (types.size === 0) {
    const tagged = message.flags?.[MODULE_ID]?.damageTypes;
    if (Array.isArray(tagged)) {
      for (const type of tagged) types.add(String(type).toLowerCase());
    }
  }
  if (types.size === 0) return;

  const actor = resolveActorByUuid(applied.uuid);
  if (!actor) return;

  reportRegenerationDamage(actor, types, currentTickTime ?? game.time.worldTime);
});

/** Флаг с типами урона приходит от клиента, который применял урон. */
Hooks.on("updateChatMessage", (message) => {
  const tagged = message?.flags?.[MODULE_ID]?.damageTypes;
  if (!Array.isArray(tagged) || tagged.length === 0) return;

  const applied = message.flags?.pf2e?.appliedDamage;
  if (!applied || applied.isHealing) return;

  const actor = resolveActorByUuid(applied.uuid);
  if (!actor) return;

  recordRegenerationDamage(
    actor,
    new Set(tagged.map((type) => String(type).toLowerCase())),
    game.time.worldTime
  );
});

/**
 * Перехватываем применение урона: в карточке применения PF2e не всегда есть
 * типы урона, а в самом DamageRoll они есть всегда.
 */
Hooks.once("init", () => {
  try {
    const proto = CONFIG.Actor.documentClass.prototype;
    if (proto.__pf2eTickerApplyDamage) return;
    const original = proto.applyDamage;
    if (typeof original !== "function") return;

    proto.__pf2eTickerApplyDamage = true;
    proto.applyDamage = async function (options = {}) {
      const hpBefore = Number(this.attributes?.hp?.value ?? 0);
      const tempBefore = Number(this.attributes?.hp?.temp ?? 0);
      const result = await original.call(this, options);

      try {
        const hpAfter = Number(this.attributes?.hp?.value ?? 0);
        const tempAfter = Number(this.attributes?.hp?.temp ?? 0);
        const tookDamage = hpAfter < hpBefore || tempAfter < tempBefore;
        if (tookDamage) {
          const types = damageTypesFromDamage(options.damage);
          if (types.size > 0) {
            reportRegenerationDamage(
              this,
              types,
              currentTickTime ?? game.time.worldTime
            );
          }
        }
      } catch {
        // Ошибки учёта не должны мешать применению урона.
      }

      return result;
    };
  } catch (err) {
    console.warn(`${MODULE_ID} | Не удалось перехватить applyDamage`, err);
  }
});

function healingSourceKey(actor, item, rule) {
  return `${getActorKey(actor)}|${item.id}|${rule.type ?? "fast-healing"}`;
}

function resolveHealingTemplate(rule, item, actor) {
  const raw = rule?.value;
  if (typeof raw === "number") return raw;
  if (raw === null || raw === undefined) return 0;

  const prepared = (actor?.rules ?? []).find(
    (candidate) =>
      candidate.key === "FastHealing" &&
      candidate.item?.id === item.id &&
      candidate.type === rule.type
  );
  try {
    return prepared?.resolveInjectedProperties?.(String(raw)) ?? String(raw);
  } catch {
    return String(raw);
  }
}

function unregisterHealingItem(actor, item) {
  const aKey = getActorKey(actor);
  for (const [key, entry] of healingRegistry) {
    if (entry.actorUuid === aKey && entry.itemId === item.id) healingRegistry.delete(key);
  }
}

function registerHealingItem(actor, item) {
  if (!actor?.items || !item) return;

  const aKey = getActorKey(actor);
  const rules = item.system?.rules ?? [];
  const ownKeys = new Set();

  rules.forEach((rule) => {
    if (rule.key !== "FastHealing") return;

    const key = healingSourceKey(actor, item, rule);
    ownKeys.add(key);
    const startRaw = Number(item.system?.start?.value ?? NaN);

    healingRegistry.set(key, {
      key,
      actorUuid: aKey,
      itemId: item.id,
      itemName: item.name,
      type: rule.type ?? "fast-healing",
      template: resolveHealingTemplate(rule, item, actor),
      deactivatedBy: Array.isArray(rule.deactivatedBy)
        ? rule.deactivatedBy.map((value) => String(value).toLowerCase())
        : [],
      startTime: Number.isFinite(startRaw) ? startRaw : -Infinity,
      expiryTime: getEffectExpiryTime(item),
      deleted: false,
    });
  });

  for (const [key, entry] of healingRegistry) {
    if (entry.actorUuid === aKey && entry.itemId === item.id && !ownKeys.has(key)) {
      healingRegistry.delete(key);
    }
  }
}

function registerActorHealing(actor) {
  for (const item of actor?.items?.contents ?? []) {
    if ((item.system?.rules ?? []).some((rule) => rule.key === "FastHealing")) {
      registerHealingItem(actor, item);
    }
  }
}

/**
 * Источники лечения на момент tickTime: живые правила + записи реестра
 * для уже удалённых (истёкших) эффектов.
 */
function getHealingSources(actor, tickTime) {
  const aKey = getActorKey(actor);
  const sources = new Map();

  for (const rule of getAllFastHealingRules(actor)) {
    const item = rule.item;
    if (!item) continue;

    const startRaw = Number(item.system?.start?.value ?? NaN);
    const start = Number.isFinite(startRaw) ? startRaw : -Infinity;
    const expiry = getEffectExpiryTime(item);
    if (tickTime < start || tickTime >= expiry) continue;

    const key = healingSourceKey(actor, item, rule);
    sources.set(key, {
      key,
      actor,
      item,
      rule,
      entry: null,
      name: item.name,
      type: rule.type ?? "fast-healing",
      deactivatedBy: Array.isArray(rule.deactivatedBy)
        ? rule.deactivatedBy.map((value) => String(value).toLowerCase())
        : [],
      start,
      expiry,
    });
  }

  for (const entry of healingRegistry.values()) {
    if (entry.actorUuid !== aKey) continue;
    // Живое правило уже учтено выше — не считаем эффект дважды.
    if (sources.has(entry.key)) continue;

    // Удалённый эффект: если к концу этого проматывания его длительность
    // ещё не истекла — это было ручное удаление, тикать не нужно. Если время
    // уже дошло до конца эффекта — PF2e удалил его при истечении, и нужно
    // дотикать пропущенные тики.
    if (entry.deleted && !(Number(currentAdvanceEnd ?? -Infinity) >= entry.expiryTime)) {
      healingRegistry.delete(entry.key);
      continue;
    }

    if (tickTime < entry.startTime || tickTime >= entry.expiryTime) continue;

    sources.set(entry.key, {
      key: entry.key,
      actor,
      item: null,
      rule: null,
      entry,
      name: entry.itemName,
      type: entry.type,
      deactivatedBy: entry.deactivatedBy ?? [],
      start: entry.startTime,
      expiry: entry.expiryTime,
    });
  }

  return [...sources.values()];
}

/** Активные persistent damage conditions. */
function getPersistentConditions(actor) {
  const conditions = actor?.itemTypes?.condition;
  if (!conditions) return [];
  return [...conditions].filter(
    (condition) =>
      condition.slug === "persistent-damage" &&
      condition.active !== false &&
      condition.system?.persistent
  );
}

/** Значение fast healing/regeneration с поддержкой формул. */
async function resolveHealingValue(rule, actor) {
  const raw = rule?.value;
  if (typeof raw === "number") return Math.max(0, raw);
  if (raw === null || raw === undefined) return 0;

  let resolved = raw;
  try {
    resolved = rule.resolveInjectedProperties?.(String(raw)) ?? raw;
  } catch {
    resolved = raw;
  }
  if (typeof resolved === "number") return Math.max(0, resolved);

  const text = String(resolved ?? "0").trim();
  if (!text) return 0;

  try {
    const value = Roll.safeEval(text);
    if (Number.isFinite(value)) return Math.max(0, value);
  } catch {
    // Не числовое выражение — ниже попробуем как бросок.
  }

  try {
    const roll = new Roll(text, actor.getRollData());
    await roll.evaluate();
    return Math.max(0, Number(roll.total) || 0);
  } catch (err) {
    console.warn(`${MODULE_ID} | Не удалось вычислить значение лечения "${text}"`, err);
    return 0;
  }
}

/** Все актёры, которых нужно обрабатывать (включая токены на сцене). */
function getActors() {
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) {
    actors.set(actor.uuid ?? actor.id, actor);
  }
  if (canvas?.ready) {
    for (const token of canvas.tokens?.placeables ?? []) {
      if (token.actor) actors.set(token.actor.uuid ?? token.actor.id, token.actor);
    }
  }
  return [...actors.values()].filter((actor) => actor.attributes?.hp);
}

/** Есть ли у актёра что обрабатывать в следующий тик. */
function hasPendingTickerEffects(actor, tickTime) {
  if (!actor?.attributes?.hp || isDeadActor(actor)) return false;
  if (getPersistentConditions(actor).length > 0) return true;

  const hp = actor.attributes.hp;
  if (hp.value >= hp.max) return false;
  return getHealingSources(actor, tickTime).length > 0;
}

/* -------------------------------------------------------------------------- */
/*  Обработка тика                                                             */
/* -------------------------------------------------------------------------- */

function ensureActorResult(results, actor) {
  let entry = results.get(actor);
  if (!entry) {
    entry = {
      actor,
      hpBefore: actor.attributes.hp.value,
      hpAfter: actor.attributes.hp.value,
      dead: false,
      persistent: new Map(),
      healing: new Map(),
    };
    results.set(actor, entry);
  }
  return entry;
}

function ensureHealingResult(entry, source) {
  let result = entry.healing.get(source.key);
  if (!result) {
    result = {
      key: source.key,
      name: source.name,
      type: source.type,
      expiry: source.expiry,
      ticks: 0,
      healed: 0,
      expired: false,
    };
    entry.healing.set(source.key, result);
  }
  return result;
}

function ensurePersistentResult(entry, condition) {
  let result = entry.persistent.get(condition.id);
  if (!result) {
    result = {
      name: condition.name,
      formula: condition.system.persistent.formula,
      damageType: condition.system.persistent.damageType,
      ticks: 0,
      rolled: 0,
      applied: 0,
      recoveredAt: null,
      active: true,
      checks: [],
    };
    entry.persistent.set(condition.id, result);
  }
  return result;
}

async function processActorTick(actor, tickTime, tickIndex, results) {
  if (!actor?.attributes?.hp || isDeadActor(actor)) return;
  const entry = ensureActorResult(results, actor);

  // 1. Fast healing / regeneration.
  for (const source of getHealingSources(actor, tickTime)) {
    if (isRegenerationSuppressed(actor, source, tickTime)) continue;
    const hp = actor.attributes.hp;
    if (hp.value >= hp.max) continue;

    const value = source.rule
      ? await resolveHealingValue(source.rule, actor)
      : await resolveHealingValue({ value: source.entry?.template ?? 0 }, actor);
    if (!(value > 0)) continue;

    capturedDamage = null;
    try {
      await postHealingCard(actor, source, value);
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось показать карточку лечения`, err);
    }
    try {
      await actor.applyDamage({
        damage: -value,
        final: true,
        token: getActorToken(actor),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось применить лечение "${source.name}"`, err);
      continue;
    }

    const result = ensureHealingResult(entry, source);
    const applied = Math.max(0, -(capturedDamage?.hpDelta ?? -value));
    result.ticks += 1;
    result.healed += applied;
    entry.hpAfter = actor.attributes.hp.value;
  }

  // 2. Persistent damage + recovery flat check.
  for (const condition of getPersistentConditions(actor)) {
    if (isDeadActor(actor)) break;

    let roll;
    try {
      roll = condition.system.persistent.damage.clone();
      await roll.evaluate();
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось бросить persistent damage`, err);
      continue;
    }

    capturedDamage = null;
    try {
      await postPersistentDamageCard(actor, condition, roll);
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось показать карточку урона`, err);
    }
    try {
      await actor.applyDamage({
        damage: roll,
        token: getActorToken(actor),
        item: condition,
        rollOptions: new Set(condition.getRollOptions("item")),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось применить persistent damage`, err);
      continue;
    }

    const result = ensurePersistentResult(entry, condition);
    result.ticks += 1;
    result.rolled += Number(roll.total) || 0;
    result.applied += Math.max(0, capturedDamage?.hpDelta ?? 0);
    entry.hpAfter = actor.attributes.hp.value;

    if (isDeadActor(actor)) {
      entry.dead = true;
      result.active = actor.items.has(condition.id);
      break;
    }

    if (!actor.items.has(condition.id)) {
      result.active = false;
      continue;
    }

    capturedRecovery = null;
    try {
      await condition.rollRecovery();
    } catch (err) {
      console.warn(`${MODULE_ID} | Не удалось бросить recovery`, err);
    }

    const check = capturedRecovery;
    const recoverySuccess =
      check?.outcome === "success" || check?.outcome === "criticalSuccess";

    result.checks.push({
      tick: tickIndex + 1,
      total: check?.total ?? null,
      dc: check?.dc ?? null,
      outcome: check?.outcome ?? null,
    });

    // decreaseCondition() внутри rollRecovery не ожидается, поэтому
    // даём условию удалиться, а если PF2e не успел — снимаем сами.
    if (recoverySuccess) {
      await waitForConditionRemoval(actor, condition.id);
      if (actor.items.has(condition.id)) {
        try {
          await actor.decreaseCondition(condition);
        } catch (err) {
          console.warn(`${MODULE_ID} | Не удалось снять persistent damage`, err);
        }
      }
    }

    if (!actor.items.has(condition.id)) {
      result.active = false;
      result.recoveredAt = tickIndex + 1;
    } else {
      result.recoveryOutcome = check?.outcome ?? null;
    }
  }
}

/** Ждём, пока PF2e удалит condition после успешного recovery. */
async function waitForConditionRemoval(actor, conditionId, timeout = 1000) {
  const started = Date.now();
  while (actor.items.has(conditionId) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/* -------------------------------------------------------------------------- */
/*  Обработка пропущенного времени                                             */
/* -------------------------------------------------------------------------- */

async function processAdvance(from, to, { actors = null } = {}) {
  if (game.system?.id !== "pf2e") return;
  if (!(to > from)) return;

  const firstTick = Math.floor(from / TICK_SECONDS) * TICK_SECONDS + TICK_SECONDS;
  if (firstTick > to) return;

  const allActors = actors ?? getActors();
  for (const actor of allActors) registerActorHealing(actor);

  currentAdvanceEnd = to;
  const candidates = allActors.filter((actor) =>
    hasPendingTickerEffects(actor, firstTick)
  );
  if (candidates.length === 0) {
    currentAdvanceEnd = null;
    return;
  }

  const results = new Map();
  ticking = true;
  try {
    let tickTime = firstTick;
    let tickIndex = 0;
    let guard = 0;

    while (tickTime <= to && guard < MAX_TICKS_PER_ADVANCE) {
      guard += 1;
      for (const actor of candidates) {
        currentTickTime = tickTime;
        await processActorTick(actor, tickTime, tickIndex, results);
      }
      currentTickTime = null;

      const nextTick = tickTime + TICK_SECONDS;
      const pending = candidates.some((actor) =>
        hasPendingTickerEffects(actor, nextTick)
      );
      if (!pending) break;

      tickTime += TICK_SECONDS;
      tickIndex += 1;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Ошибка обработки тиков`, err);
  } finally {
    ticking = false;
    currentTickTime = null;
  }

  if (results.size > 0 && to - from >= TICK_SECONDS * 5) {
    let ticks = 0;
    let healed = 0;
    for (const result of results.values()) {
      for (const healing of result.healing.values()) {
        ticks += healing.ticks;
        healed += healing.healed;
      }
      for (const persistent of result.persistent.values()) ticks += persistent.ticks;
    }
    void writeDiagnostics({
      lastAdvance: {
        from,
        to,
        actors: results.size,
        ticks,
        healed,
        at: Date.now(),
      },
    });
  }

  // Эффекты, чья длительность уже закончилась, больше не понадобятся.
  // Удалённые вручную (не истёкшие) записи тоже больше не нужны.
  for (const [key, entry] of healingRegistry) {
    if (entry.deleted || entry.expiryTime <= to) healingRegistry.delete(key);
  }
  currentAdvanceEnd = null;
}

/* -------------------------------------------------------------------------- */
/*  Мировое время                                                              */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "diagnostics", {
    name: "PF2e Ticker diagnostics",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
});

Hooks.once("ready", () => {
  if (game.system?.id !== "pf2e") return;
  lastTickerTime = Number(game.time.worldTime ?? 0);
  for (const actor of game.actors?.contents ?? []) registerActorHealing(actor);
  patchFastHealingRule();

  console.info(
    `${MODULE_ID} | build ${BUILD} loaded for ${game.user.name} (${game.user.id})`
  );
  if (game.user.isGM) void writeDiagnostics({ loadedAt: Date.now() });
});

Hooks.on("canvasReady", () => {
  if (game.system?.id !== "pf2e") return;
  for (const actor of getActors()) registerActorHealing(actor);
});

Hooks.on("createItem", (item) => {
  if (game.system?.id !== "pf2e") return;
  const actor = getItemActor(item);
  if (!actor) return;
  if ((item.system?.rules ?? []).some((rule) => rule.key === "FastHealing")) {
    registerHealingItem(actor, item);
  }
});

Hooks.on("updateItem", (item) => {
  if (game.system?.id !== "pf2e") return;
  const actor = getItemActor(item);
  if (!actor) return;
  if ((item.system?.rules ?? []).some((rule) => rule.key === "FastHealing")) {
    registerHealingItem(actor, item);
  } else {
    unregisterHealingItem(actor, item);
  }
});

Hooks.on("deleteItem", (item) => {
  if (game.system?.id !== "pf2e") return;
  const actor = getItemActor(item);
  if (!actor) return;

  const aKey = getActorKey(actor);
  const entries = [...healingRegistry.values()].filter(
    (entry) => entry.actorUuid === aKey && entry.itemId === item.id
  );
  if (entries.length === 0) return;

  // Не удаляем запись сразу: PF2e может удалить эффект на другом клиенте
  // раньше, чем у нас обновится игровое время. Оставляем данные, а решение
  // «это автоудаление или ручное удаление» принимаем при проматывании:
  // если время дошло до конца эффекта — дотикаем, иначе считаем ручным.
  for (const entry of entries) entry.deleted = true;
});

Hooks.on("deleteActor", (actor) => {
  if (game.system?.id !== "pf2e") return;
  const aKey = getActorKey(actor);
  regenerationSuppression.delete(aKey);
  combatRegenerationSuppression.delete(aKey);
  for (const [key, entry] of healingRegistry) {
    if (entry.actorUuid === aKey) healingRegistry.delete(key);
  }
});

Hooks.on("updateWorldTime", (worldTime, delta, options, userId) => {
  if (game.system?.id !== "pf2e") return;

  const previous = lastTickerTime ?? worldTime;
  lastTickerTime = worldTime;

  if (isTickerOwner() && Math.abs(worldTime - previous) >= TICK_SECONDS * 5) {
    void writeDiagnostics({ lastHook: { previous, worldTime, delta, at: Date.now() } });
  }

  if (!isTickerOwner()) return;
  if (game.combat?.started) return;
  if (!(worldTime > previous)) return;

  processingQueue = processingQueue
    .then(() => processAdvance(previous, worldTime))
    .catch((err) => console.error(`${MODULE_ID} | Ошибка обработки времени`, err));
});

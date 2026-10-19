import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import fengari from 'fengari';
import { toLua } from '../scripts/build-data.mjs';

const { lua, lauxlib, lualib, to_luastring } = fengari;
const source = await fs.readFile(new URL('../QuickWoWTalentsPreferences.lua', import.meta.url), 'utf8');
const codecSource = await fs.readFile(new URL('../QuickWoWTalentsTalentCodec.lua', import.meta.url), 'utf8');
const catalog = JSON.parse(gunzipSync(await fs.readFile(new URL('./fixtures/talent-codec-catalog.json.gz', import.meta.url))));

// Independent catalog snapshot: node and entry order from 12.1.5.70391. Spell
// identities are needed to distinguish same-name targeting talents at runtime.
const pairs = [
  { key: 'earthquakeTargeting', spec: 262, node: 80985, entries: [101855, 127925], spells: [462620, 61882], choices: ['target', 'ground'] },
  { key: 'flamestrikeTargeting', spec: 63, node: 109409, entries: [135619, 135602], spells: [2120, 1254851], choices: ['ground', 'target'] },
  { key: 'blizzardTargeting', spec: 64, node: 108864, entries: [134421, 134538], spells: [190356, 1248829], choices: ['ground', 'target'] },
  { key: 'rainOfFireTargeting', spec: 267, node: 72069, entries: [91592, 128601], spells: [5740, 1214467], choices: ['ground', 'target'] },
  { key: 'thistleTeaActivation', spec: 259, node: 90756, entries: [112648, 137464], spells: [469779, 1298826], choices: ['automatic', 'manual'] },
  { key: 'mageMovement', spec: 62, node: 62105, entries: [80163, 134197], spells: [212653, 1244340], choices: ['shimmer', 'improvedBlink'] },
  { key: 'monkMovement', spec: 268, node: 101183, entries: [124982, 124981], spells: [115173, 115008], choices: ['celerity', 'chiTorpedo'] },
  { key: 'druidMovement', spec: 104, node: 82198, entries: [103276, 103275], spells: [102401, 252216], choices: ['wildCharge', 'tigerDash'] },
  { key: 'shamanMovement', spec: 262, node: 103591, entries: [127865, 127864], spells: [58875, 192063], choices: ['spiritWalk', 'gustOfWind'] },
  { key: 'verdantEmbraceStyle', spec: 1468, node: 93243, entries: [115546, 133503], spells: [1241669, 1241704], choices: ['dreamSimulacrum', 'wingsOfLiberty'] },
  { key: 'hunterCompanion', spec: 253, node: 110158, entries: [136679, 136678], spells: [267116, 474746], choices: ['animalCompanion', 'solitaryCompanion'] },
  { key: 'frostCompanion', spec: 64, node: 108850, entries: [134406, 136839], spells: [31687, 205024], choices: ['waterElemental', 'lonelyWinter'] }
];

function encode(specID, choice = 0, { absent = false, granted = false } = {}) {
  const bits = [];
  const put = (value, width) => { for (let bit = 0; bit < width; bit++) bits.push((value >> bit) & 1); };
  put(2, 8); put(specID, 16);
  for (let index = 0; index < 16; index++) put(0, 8);
  put(1, 1); put(0, 1); // Unrelated granted single node.
  put(absent ? 0 : 1, 1);
  if (!absent) {
    put(granted ? 0 : 1, 1);
    if (!granted) { put(0, 1); put(1, 1); put(choice, 2); }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bits.length; index += 6) {
    result += alphabet[bits.slice(index, index + 6).reduce((value, bit, shift) => value + bit * 2 ** shift, 0)];
  }
  return result;
}

function harness(pair = pairs[0]) {
  const state = lua.lua_newstate();
  lualib.luaL_openlibs(state);
  const run = text => {
    if (lauxlib.luaL_dostring(state, to_luastring(text)) !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(state, -1));
  };
  const value = expression => {
    run(`return ${expression}`);
    const kind = lua.lua_type(state, -1);
    const result = kind === lua.LUA_TBOOLEAN ? lua.lua_toboolean(state, -1)
      : kind === lua.LUA_TNUMBER ? lua.lua_tonumber(state, -1)
        : kind === lua.LUA_TNIL ? null : lua.lua_tojsstring(state, -1);
    lua.lua_pop(state, 1);
    return result;
  };
  run(`
    ns = { Identity = { dbGlobal = "TestPreferencesDB" } }
    TestPreferencesDB = { autoOpenEnabled = false }
    TEST = { guid = "Player-A", reads = 0, mutations = 0,
      node = { ID = ${pair.node}, type = 2, maxRanks = 1, entryIDs = ${toLua(pair.entries)},
        activeEntry = { entryID = ${pair.entries[0]} }, isAvailable = false },
      entries = {
        [2001] = { maxRanks = 1 },
        [${pair.entries[0]}] = { definitionID = 1, maxRanks = 1, isAvailable = false },
        [${pair.entries[1]}] = { definitionID = 2, maxRanks = 1, isAvailable = false }
      },
      definitions = { [1] = { spellID = ${pair.spells[0]} }, [2] = { spellID = ${pair.spells[1]} } }
    }
    UnitGUID = function() return TEST.guid end
    Enum = { TraitNodeType = { Single = 0, Tiered = 1, Selection = 2, SubTreeSelection = 3 } }
    local function mutation() TEST.mutations = TEST.mutations + 1; error("Game mutation forbidden") end
    C_ClassTalents = { GetTraitTreeForSpec = function() return 99 end,
      ImportLoadout = mutation, DeleteConfig = mutation, LoadConfig = mutation }
    C_Traits = {
      GetConfigInfo = function() return { treeIDs = { 99 } } end,
      GetLoadoutSerializationVersion = function() return 2 end,
      GetTreeNodes = function() return { 1001, ${pair.node} } end,
      GetNodeInfo = function(_, id)
        TEST.reads = TEST.reads + 1
        if id == 1001 then return { ID = 1001, type = 0, maxRanks = 1, entryIDs = { 2001 } } end
        return TEST.node
      end,
      GetEntryInfo = function(_, id) TEST.reads = TEST.reads + 1; return TEST.entries[id] end,
      GetDefinitionInfo = function(id) TEST.reads = TEST.reads + 1; return TEST.definitions[id] end,
      SetSelection = mutation, PurchaseRank = mutation, CommitConfig = mutation, RollbackConfig = mutation
    }
    (function(...)
    ${codecSource}
    end)("Test", ns)
  `);
  const reload = () => run(`(function(...)
    ${source}
    end)("Test", ns)`);
  reload();
  return { run, value, reload,
    set(choice) { run(`assert(ns.Preferences.Set(${pair.spec}, ${toLua(pair.key)}, ${toLua(choice)}))`); },
    build(text = encode(pair.spec)) {
      run(`result, status = ns.Preferences.Build(${toLua(text)}, ${pair.spec}, 900)`);
      assert.equal(value('TEST.mutations'), 0);
      return { text: value('result'), error: value('status.error'), applied: value('#status.applied'),
        skipped: value('#status.skipped'), changed: value('status.changedCount') };
    },
    close() { lua.lua_close(state); }
  };
}

test('defaults retain the recommendation without an active configuration, decoder or saved settings', () => {
  const h = harness();
  h.run('C_Traits = nil; ns.TalentCodec = nil; UnitGUID = nil');
  assert.equal(h.build('COPY-UNCHANGED').text, 'COPY-UNCHANGED');
  assert.equal(h.value('TestPreferencesDB.talentPreferences'), null);
  assert.equal(h.value('TestPreferencesDB.autoOpenEnabled'), false);
  h.close();
});

test('all 12 preference pairs match current node/entry catalog and expose only relevant specs', () => {
  const h = harness();
  for (const pair of pairs) {
    const node = catalog.specs[pair.spec].nodes.find(node => node.id === pair.node);
    assert.equal(node.type, 'choice');
    assert.deepEqual(node.entries.map(entry => entry.id), pair.entries);
  }
  for (const [spec, count] of [[62, 1], [63, 2], [64, 3], [262, 2], [263, 1], [264, 1], [259, 1], [260, 1], [261, 1],
    [102, 1], [103, 1], [104, 1], [105, 1], [268, 1], [269, 1], [270, 1], [267, 1], [1468, 1], [253, 1], [65, 0], [1467, 0]]) {
    assert.equal(h.value(`#ns.Preferences.List(${spec})`), count, `spec ${spec}`);
  }
  assert.equal(h.value('#ns.Preferences.List(nil)'), 0);
  h.close();
});

test('preferences survive module/data reload and remain isolated per character and specialization', () => {
  const h = harness();
  h.set('ground');
  h.run('assert(ns.Preferences.Set(262, "shamanMovement", "gustOfWind"))');
  h.reload();
  assert.equal(h.value('ns.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
  assert.equal(h.value('ns.Preferences.Get(264, "shamanMovement")'), 'recommended');
  h.run('TEST.guid = "Player-B"');
  assert.equal(h.value('ns.Preferences.Get(262, "earthquakeTargeting")'), 'recommended');
  h.set('target');
  h.run('TEST.guid = "Player-A"');
  assert.equal(h.value('ns.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
  assert.equal(h.value('TestPreferencesDB.autoOpenEnabled'), false);
  h.close();
});

test('invalid choices and unavailable character identity cannot write account-wide fallback settings', () => {
  const h = harness();
  h.run('ok, err = ns.Preferences.Set(264, "earthquakeTargeting", "ground"); assert(not ok)');
  h.run('ok, err = ns.Preferences.Set(262, "earthquakeTargeting", "invented"); assert(not ok)');
  h.run('TEST.guid = nil; ok, err = ns.Preferences.Set(262, "earthquakeTargeting", "ground")');
  assert.equal(h.value('ok'), null);
  assert.match(h.value('err'), /Character identity/);
  assert.equal(h.value('TestPreferencesDB.talentPreferences'), null);
  h.close();
});

test('reset only clears known preferences for this character/spec and recommended removes an override', () => {
  const h = harness();
  h.set('ground');
  h.run('TestPreferencesDB.talentPreferences.characters["Player-A"][262].futureSetting = "preserved"');
  h.set('recommended');
  assert.equal(h.value('TestPreferencesDB.talentPreferences.characters["Player-A"][262].earthquakeTargeting'), null);
  h.set('ground');
  h.run('assert(ns.Preferences.Reset(262))');
  assert.equal(h.value('ns.Preferences.Get(262, "earthquakeTargeting")'), 'recommended');
  assert.equal(h.value('TestPreferencesDB.talentPreferences.characters["Player-A"][262].futureSetting'), 'preserved');
  h.close();
});

for (const pair of pairs) {
  test(`${pair.key}: both choices produce exactly the expected build without changing grants or ranks`, () => {
    const h = harness(pair);
    for (let choice = 0; choice < 2; choice++) {
      h.set(pair.choices[choice]);
      assert.deepEqual(h.build(encode(pair.spec, 1 - choice)), {
        text: encode(pair.spec, choice), error: null, applied: 1, skipped: 0, changed: 1
      });
      assert.equal(h.value('status.applied[1].key'), pair.key);
      assert.equal(h.value('status.applied[1].choice'), pair.choices[choice]);
    }
    h.close();
  });
}

test('matching preferred talent is reported as applied without rewriting the original string', () => {
  const h = harness();
  h.set('target');
  assert.deepEqual(h.build(), { text: encode(262), error: null, applied: 1, skipped: 0, changed: 0 });
  assert.equal(h.value('ns.Preferences.Describe(status)'), '1 preference applied.');
  h.close();
});

for (const mode of ['absent', 'granted']) {
  test(`${mode} preference node is visibly skipped and never injected into the recommendation`, () => {
    const h = harness();
    h.set('ground');
    const text = encode(262, 0, { [mode]: true });
    assert.deepEqual(h.build(text), { text, error: null, applied: 0, skipped: 1, changed: 0 });
    assert.equal(h.value('status.skipped[1].reason'), 'Not selected in this recommended build.');
    assert.equal(h.value('ns.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
    h.close();
  });
}

for (const [name, mutate] of [
  ['changed spell identity', 'TEST.definitions[2].spellID = 999999'],
  ['extra choice entry', 'TEST.node.entryIDs[3] = 555555'],
  ['hero subtree membership', 'TEST.node.subTreeID = 81'],
  ['entry subtree selection', 'TEST.entries[127925].subTreeID = 81'],
  ['changed node ranks', 'TEST.node.maxRanks = 2; TEST.entries[101855].maxRanks = 2'],
  ['unreadable alternative definition', 'C_Traits.GetDefinitionInfo = function() error("PRIVATE API VALUE") end'],
  ['secret spell identity', 'issecretvalue = function(v) return v == "SECRET" end; TEST.definitions[2].spellID = "SECRET"']
]) {
  test(`${name} keeps the saved setting and skips the override without leaking API values`, () => {
    const h = harness();
    h.set('ground');
    h.run(mutate);
    const result = h.build();
    assert.equal(result.text, encode(262));
    assert.equal(result.skipped, 1);
    assert.equal(result.applied, 0);
    assert.doesNotMatch(h.value('status.skipped[1].reason'), /PRIVATE|SECRET/);
    assert.equal(h.value('ns.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
    h.close();
  });
}

test('missing settings version and future semantic choices are preserved and visibly skipped', () => {
  const h = harness();
  h.run('TestPreferencesDB.talentPreferences = { version = 2, marker = "keep" }');
  assert.equal(h.build().skipped, 1);
  h.run('ok, err = ns.Preferences.Set(262, "earthquakeTargeting", "ground")');
  assert.equal(h.value('ok'), null);
  assert.equal(h.value('TestPreferencesDB.talentPreferences.marker'), 'keep');
  h.run('TestPreferencesDB.talentPreferences = nil');
  h.set('ground');
  h.run('TestPreferencesDB.talentPreferences.characters["Player-A"][262].earthquakeTargeting = "future-choice"');
  assert.equal(h.build().skipped, 1);
  assert.equal(h.value('TestPreferencesDB.talentPreferences.characters["Player-A"][262].earthquakeTargeting'), 'future-choice');
  h.close();
});

test('malformed recommendation blocks personalized copy/import rather than silently ignoring configured choices', () => {
  const h = harness();
  h.set('ground');
  const result = h.build('malformed!');
  assert.equal(result.text, null);
  assert.match(result.error, /could not be read safely/);
  assert.equal(result.applied, 0);
  h.close();
});

test('codec mutation failure or exception cannot produce a fallback with falsely applied preferences', () => {
  const h = harness();
  h.set('ground');
  h.run('ns.TalentCodec.ApplyChoices = function() error("PRIVATE DATA") end');
  const result = h.build();
  assert.equal(result.text, null);
  assert.equal(result.applied, 0);
  assert.match(result.error, /could not be verified/);
  assert.doesNotMatch(result.error, /PRIVATE/);
  h.close();
});

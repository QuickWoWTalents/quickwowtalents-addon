import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import fengari from 'fengari';
import { toLua } from '../scripts/build-data.mjs';
import { parseAddonLua } from '../scripts/parse-addon-lua.mjs';

const { lua, lauxlib, lualib, to_luastring } = fengari;
const source = await fs.readFile(new URL('../QuickWoWTalentsTalentCodec.lua', import.meta.url), 'utf8');
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/current-arcane-normalized-spec.json', import.meta.url), 'utf8'));
const bundled = parseAddonLua(await fs.readFile(new URL('../QuickWoWTalentsData.lua', import.meta.url), 'utf8'));
const catalog = JSON.parse(gunzipSync(await fs.readFile(new URL('./fixtures/talent-codec-catalog.json.gz', import.meta.url))));
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const types = { single: 0, tiered: 1, choice: 2, subtree: 3 };
const baseNodes = [
  { id: 1001, type: 'single', maxRanks: 1, entries: [{ id: 2001, maxRanks: 1 }] },
  { id: 1002, type: 'single', maxRanks: 3, entries: [{ id: 2002, maxRanks: 3 }] },
  { id: 1003, type: 'choice', maxRanks: 1, entries: [{ id: 2003, maxRanks: 1 }, { id: 2004, maxRanks: 1 }] },
  { id: 1004, type: 'subtree', maxRanks: 1, entries: [{ id: 2005, maxRanks: 1, subTreeID: 81 }, { id: 2006, maxRanks: 1, subTreeID: 82 }] },
  { id: 1005, type: 'tiered', maxRanks: 4, entries: [{ id: 2007, maxRanks: 1 }, { id: 2008, maxRanks: 2 }, { id: 2009, maxRanks: 1 }] },
  { id: 1006, type: 'single', maxRanks: 1, entries: [{ id: 2010, maxRanks: 1 }] }
];
const allChoices = [{ granted: true }, { partial: 2 }, { choice: 1 }, { choice: 1 }, { partial: 3 }, null];

// Independent fixture writer: append individual low-order bits, then group six.
function encode(selections = allChoices, { version = 2, specID = 62, hash = Array(16).fill(0) } = {}) {
  const bits = [];
  const add = (value, width) => { for (let bit = 0; bit < width; bit++) bits.push((value >> bit) & 1); };
  add(version, 8); add(specID, 16); hash.forEach(byte => add(byte, 8));
  for (const selection of selections) {
    add(selection ? 1 : 0, 1);
    if (!selection) continue;
    add(selection.granted ? 0 : 1, 1);
    if (selection.granted) continue;
    add(selection.partial !== undefined ? 1 : 0, 1);
    if (selection.partial !== undefined) add(selection.partial, 6);
    add(selection.choice !== undefined ? 1 : 0, 1);
    if (selection.choice !== undefined) add(selection.choice, 2);
  }
  let text = '';
  for (let index = 0; index < bits.length; index += 6) {
    let value = 0;
    for (let bit = 0; bit < 6; bit++) value += (bits[index + bit] ?? 0) * 2 ** bit;
    text += alphabet[value];
  }
  return { text, bitCount: bits.length };
}

function encodeCatalogEntries(entries, specID, specCatalog) {
  const nodes = new Map(specCatalog.nodes.map(node => [node.id, node]));
  const selections = specCatalog.fullNodeOrder.map(nodeID => {
    const selected = entries.filter(entry => entry.nodeID === nodeID);
    if (!selected.length) return null;
    const ranks = selected.reduce((sum, entry) => sum + entry.ranksPurchased, 0);
    if (ranks === 0) return { granted: true };
    const node = nodes.get(nodeID);
    const result = ranks === node.maxRanks ? {} : { partial: ranks };
    if (node.type === 'choice' || node.type === 'subtree') {
      assert.equal(selected.length, 1);
      result.choice = node.entries.findIndex(entry => entry.id === selected[0].selectionEntryID);
      assert.ok(result.choice >= 0);
    }
    return result;
  });
  return encode(selections, { specID }).text;
}

function harness({ nodes = baseNodes, order = nodes.map(node => node.id), treeID = 658 } = {}) {
  const state = lua.lua_newstate();
  lualib.luaL_openlibs(state);
  const run = text => {
    if (lauxlib.luaL_dostring(state, to_luastring(text)) !== lua.LUA_OK) {
      throw new Error(lua.lua_tojsstring(state, -1));
    }
  };
  const value = expression => {
    run(`return ${expression}`);
    const result = lua.lua_type(state, -1) === lua.LUA_TBOOLEAN ? lua.lua_toboolean(state, -1)
      : lua.lua_type(state, -1) === lua.LUA_TNUMBER ? lua.lua_tonumber(state, -1)
        : lua.lua_type(state, -1) === lua.LUA_TNIL ? null : lua.lua_tojsstring(state, -1);
    lua.lua_pop(state, 1);
    return result;
  };
  const nodeMap = Object.fromEntries(nodes.map(node => [String(node.id), {
    ID: node.id, type: types[node.type], maxRanks: node.maxRanks, entryIDs: node.entries.map(entry => entry.id),
    activeEntry: { entryID: node.entries[0].id }, isAvailable: false, isVisible: false
  }]));
  const entryMap = Object.fromEntries(nodes.flatMap(node => node.entries.map(entry => [String(entry.id), {
    maxRanks: entry.maxRanks, ...(node.type === 'subtree' ? { subTreeID: entry.subTreeID ?? entry.id } : {}), isAvailable: false
  }])));
  run(`TEST = { nodes = ${toLua(nodeMap)}, entries = ${toLua(entryMap)}, order = ${toLua(order)}, treeID = ${treeID},
    hash = ${toLua(Array(16).fill(7))}, mutations = 0, reads = 0 }
    ns = {}
    Enum = { TraitNodeType = { Single = 0, Tiered = 1, Selection = 2, SubTreeSelection = 3 } }
    local function mutation() TEST.mutations = TEST.mutations + 1; error('mutation forbidden') end
    PlayerSpellsUtil = { OpenToClassTalentsTab = mutation }
    PlayerSpellsFrame = { TalentsFrame = { ImportLoadout = mutation, ViewLoadout = mutation } }
    C_ClassTalents = { GetTraitTreeForSpec = function() TEST.reads = TEST.reads + 1; return TEST.treeID end,
      ImportLoadout = mutation, DeleteConfig = mutation, LoadConfig = mutation, InitializeViewLoadout = mutation }
    C_Traits = {
      GetConfigInfo = function() TEST.reads = TEST.reads + 1; return { treeIDs = { TEST.treeID } } end,
      GetLoadoutSerializationVersion = function() return 2 end,
      GetTreeHash = function() return TEST.hash end,
      GetTreeNodes = function() return TEST.order end,
      GetNodeInfo = function(_, id) return TEST.nodes[id] end,
      GetEntryInfo = function(_, id) return TEST.entries[id] end,
      GenerateImportString = function() return TEST.exportString end,
      PurchaseRank = mutation, SetSelection = mutation, RollbackConfig = mutation, CommitConfig = mutation
    }
    (function(...)
    ${source}
    end)('QuickWoWTalents', ns)`);
  return {
    run, value,
    decode(text, specID = 62) {
      run(`result, decodeError, metadata = ns.TalentCodec.Decode(${toLua(text)}, ${specID}, 900)`);
      const error = value('decodeError');
      const entries = value('result ~= nil') ? Array.from({ length: value('#result') }, (_, index) => Object.fromEntries(
        ['nodeID', 'ranksGranted', 'ranksPurchased', 'selectionEntryID'].map(key => [key, value(`result[${index + 1}].${key}`)]))) : null;
      assert.equal(value('TEST.mutations'), 0);
      return { entries, error };
    },
    verify(text, expectedTree = treeID) {
      run(`TEST.exportString = ${toLua(text)}; metadata.treeID = ${expectedTree}; verified, verifyError = ns.TalentCodec.Verify(901, result, metadata)`);
      assert.equal(value('TEST.mutations'), 0);
      return { ok: value('verified'), error: value('verifyError') };
    },
    close() { lua.lua_close(state); }
  };
}

test('codec reads granted, partial, choice, inactive hero subtree and tiered nodes without UI or mutations', () => {
  const h = harness();
  const decoded = h.decode(encode().text);
  assert.equal(decoded.error, null);
  assert.deepEqual(decoded.entries, [
    { nodeID: 1001, ranksGranted: 1, ranksPurchased: 0, selectionEntryID: 2001 },
    { nodeID: 1002, ranksGranted: 0, ranksPurchased: 2, selectionEntryID: 2002 },
    { nodeID: 1003, ranksGranted: 0, ranksPurchased: 1, selectionEntryID: 2004 },
    { nodeID: 1004, ranksGranted: 0, ranksPurchased: 1, selectionEntryID: 2006 },
    { nodeID: 1005, ranksGranted: 0, ranksPurchased: 1, selectionEntryID: 2007 },
    { nodeID: 1005, ranksGranted: 0, ranksPurchased: 2, selectionEntryID: 2008 }
  ]);
  assert.equal(h.value('metadata.treeID'), 658);
  assert.equal(h.value('metadata.specID'), 62);
  h.close();
});

test('codec decodes the published current Arcane fixture with hero and four-rank tiered talents', () => {
  const h = harness({ nodes: Object.values(fixture.specRecord.nodes), order: fixture.specRecord.fullNodeOrder });
  const decoded = h.decode(fixture.importString);
  assert.equal(decoded.error, null);
  assert.ok(decoded.entries.length > 50);
  assert.ok(decoded.entries.some(entry => entry.nodeID === 99830));
  assert.ok(decoded.entries.some(entry => entry.nodeID === 110420));
  assert.deepEqual(h.verify(fixture.importString), { ok: true, error: null });
  h.close();
});

test('every bundled recommendation has a valid Blizzard alphabet, v2 spec header and zero catalog hash', () => {
  let count = 0;
  for (const [specID, spec] of Object.entries(bundled.recommendations)) {
    for (const mode of ['mplus', 'raid']) {
      for (const recommendation of Object.values(spec[mode]?.encounters ?? {})) {
        const text = recommendation.importString;
        assert.match(text, /^[A-Za-z0-9+/]+$/);
        assert.ok(text.length * 6 > 152, `${specID}: complete header and node content`);
        const bits = [...text].flatMap(character => Array.from({ length: 6 }, (_, bit) =>
          (alphabet.indexOf(character) >> bit) & 1));
        const number = (start, width) => bits.slice(start, start + width).reduce((value, bit, index) => value + bit * 2 ** index, 0);
        assert.equal(number(0, 8), 2);
        assert.equal(number(8, 16), Number(specID));
        assert.ok(bits.slice(24, 152).every(bit => bit === 0));
        count++;
      }
    }
  }
  assert.equal(count, bundled.counts.emitted);
  assert.equal(Object.keys(bundled.recommendations).length, bundled.counts.specsWithAnyRecommendation);
  assert.ok(count >= 700, 'Exercise the complete current release, not a toy bundle');
});

test('all bundled builds decode against the matching full 40-spec catalog fixture', () => {
  assert.equal(bundled.talentCatalog.contentHash, catalog.contentHash);
  let count = 0;
  for (const [specID, spec] of Object.entries(bundled.recommendations)) {
    const specCatalog = catalog.specs[specID];
    assert.ok(specCatalog, `Missing catalog spec ${specID}`);
    const h = harness({ nodes: specCatalog.nodes, order: specCatalog.fullNodeOrder, treeID: specCatalog.traitTreeId });
    for (const mode of ['mplus', 'raid']) {
      for (const recommendation of Object.values(spec[mode]?.encounters ?? {})) {
        const decoded = h.decode(recommendation.importString, Number(specID));
        assert.equal(decoded.error, null, `${mode}: ${recommendation.label}`);
        assert.ok(decoded.entries.length > 0);
        count++;
      }
    }
    h.close();
  }
  assert.equal(count, bundled.counts.emitted);
  assert.equal(Object.keys(catalog.specs).length, 40);
});

test('granted tiered nodes retain only their first entry and full ranks distribute across all entries', () => {
  const h = harness();
  const selections = baseNodes.map(() => null);
  selections[4] = { granted: true };
  assert.deepEqual(h.decode(encode(selections).text).entries, [
    { nodeID: 1005, ranksGranted: 1, ranksPurchased: 0, selectionEntryID: 2007 }
  ]);
  selections[4] = {};
  assert.deepEqual(h.decode(encode(selections).text).entries.map(entry => entry.ranksPurchased), [1, 2, 1]);
  h.close();
});

test('empty current trees with no hero selection decode the same requested builds across all specs', () => {
  for (const [specID, spec] of Object.entries(bundled.recommendations)) {
    const specCatalog = catalog.specs[specID];
    const recommendation = Object.values(spec.mplus?.encounters ?? spec.raid?.encounters ?? {})[0];
    assert.ok(recommendation, `Missing recommendation for ${specID}`);
    const h = harness({ nodes: specCatalog.nodes, order: specCatalog.fullNodeOrder, treeID: specCatalog.traitTreeId });
    const expected = h.decode(recommendation.importString, Number(specID));
    assert.equal(expected.error, null);
    for (const activeEntry of ['nil', '{}']) {
      h.run(`for _, node in pairs(TEST.nodes) do
        node.activeEntry = ${activeEntry}; node.ranksPurchased = 0; node.currentRank = 0
        node.isAvailable = false; node.isVisible = false
      end`);
      assert.deepEqual(h.decode(recommendation.importString, Number(specID)), expected, `empty ${specID}, activeEntry=${activeEntry}`);
    }
    h.close();
  }
});

test('codec accepts zero and matching hashes, rejects mismatched hashes and unavailable tree/configuration', () => {
  const h = harness();
  assert.equal(h.decode(encode().text).error, null);
  assert.equal(h.decode(encode(allChoices, { hash: Array(16).fill(7) }).text).error, null);
  assert.match(h.decode(encode(allChoices, { hash: Array(16).fill(8) }).text).error, /outdated/);
  h.run('C_Traits.GetConfigInfo = function() return { treeIDs = { 999 } } end');
  assert.match(h.decode(encode().text).error, /different talent tree/);
  h.close();
});

test('malformed alphabet, headers, version, spec, truncation, trailing data and padding fail closed', () => {
  const good = encode();
  const finalValue = alphabet.indexOf(good.text.at(-1));
  const nonzeroPadding = good.text.slice(0, -1) + alphabet[finalValue + 2 ** (good.bitCount % 6)];
  for (const [name, text, pattern] of [
    ['empty', '', /base64/], ['invalid', 'AA=A', /base64/], ['whitespace', `${good.text}\n`, /base64/],
    ['header', good.text.slice(0, 4), /truncated/], ['version', encode(allChoices, { version: 3 }).text, /version/],
    ['spec', encode(allChoices, { specID: 63 }).text, /different specialization/],
    ['content', good.text.slice(0, -2), /truncated/], ['trailing', `${good.text}A`, /trailing/],
    ['padding', nonzeroPadding, /padding/], ['empty build', encode(baseNodes.map(() => null)).text, /no selected/]
  ]) {
    const h = harness();
    const result = h.decode(text);
    assert.equal(result.entries, null, name);
    assert.match(result.error, pattern, name);
    h.close();
  }
});

test('invalid partial ranks, incompatible choice flags and out-of-range choices are rejected', () => {
  for (const [index, value, pattern] of [
    [1, { partial: 0 }, /partial rank/], [1, { partial: 3 }, /partial rank/],
    [1, { partial: 4 }, /partial rank/], [1, { choice: 0 }, /choice flag/],
    [2, {}, /choice flag/], [2, { choice: 3 }, /choice index/], [3, { choice: 3 }, /choice index/]
  ]) {
    const h = harness();
    const selections = structuredClone(allChoices);
    selections[index] = value;
    assert.match(h.decode(encode(selections).text).error, pattern);
    h.close();
  }
});

test('missing, throwing, malformed and secret-valued public metadata fail without mutations', () => {
  const setups = [
    'C_Traits.GetNodeInfo = nil',
    'C_Traits.GetNodeInfo = function() error("unavailable") end',
    'TEST.nodes[1002] = nil',
    'TEST.nodes[1002].maxRanks = 0',
    'TEST.nodes[1002].entryIDs = { 2002, 2002 }',
    'TEST.nodes[1002].activeEntry.entryID = 99999',
    'TEST.nodes[1002].type = 99',
    'TEST.nodes[1002].entryIDs = { [2] = 2002 }',
    'TEST.entries[2002].maxRanks = 1',
    'TEST.entries[2008] = nil',
    'TEST.entries[2008].maxRanks = 0',
    'TEST.entries[2008].maxRanks = 1; TEST.entries[2009].maxRanks = 1; TEST.nodes[1005].maxRanks = 5',
    'TEST.entries[2006].subTreeID = nil',
    'TEST.order = { 1001, 1001 }',
    'TEST.order = { [1] = 1001, [3] = 1002 }',
    'C_Traits.GetLoadoutSerializationVersion = function() return 3 end',
    'issecretvalue = function(value) return value == 3 end',
    'Enum.TraitNodeType.Tiered = nil'
  ];
  for (const setup of setups) {
    const h = harness();
    h.run(setup);
    const selections = structuredClone(allChoices);
    selections[4] = {};
    const decoded = h.decode(encode(selections).text);
    assert.equal(decoded.entries, null, setup);
    assert.equal(typeof decoded.error, 'string', setup);
    h.close();
  }
});

test('whole-tree verification tolerates hash representation but rejects extra/missing ranks and hero choice changes', () => {
  const h = harness();
  assert.equal(h.decode(encode().text).error, null);
  assert.equal(h.verify(encode(allChoices, { hash: Array(16).fill(7) }).text).ok, true);
  for (const [index, selection] of [[1, { partial: 1 }], [1, null], [3, { choice: 0 }], [4, {}], [5, {}]]) {
    const selections = structuredClone(allChoices);
    selections[index] = selection;
    assert.equal(h.verify(encode(selections).text).ok, false);
  }
  assert.equal(h.verify(encode().text, 999).ok, false);
  h.run('C_Traits.GenerateImportString = function() return nil end');
  assert.equal(h.verify(encode().text).ok, false);
  h.close();
});

test('verification rejects purchased differences after normalizing automatic grants', () => {
  const h = harness();
  const good = encode().text;
  h.decode(good);
  h.run('result[2].ranksPurchased = 1; result[5].ranksPurchased = 0');
  assert.equal(h.verify(good).ok, false);

  h.close();
});

test('automatic single-entry grants may be omitted or added without changing the imported entries', () => {
  const h = harness();
  const good = encode().text;
  const noGrant = structuredClone(allChoices);
  noGrant[0] = null;
  const original = h.decode(good).entries;
  assert.equal(h.verify(encode(noGrant).text).ok, true);

  assert.equal(h.value('#result'), original.length, 'Verification must not strip native import entries');
  assert.equal(h.value('result[1].ranksGranted'), 1);
  h.decode(encode(noGrant).text);
  assert.equal(h.verify(good).ok, true);
  h.decode(good);
  const paidInstead = structuredClone(allChoices);
  paidInstead[0] = {};
  assert.equal(h.verify(encode(paidInstead).text).ok, false, 'A grant becoming a purchase is a real difference');

  h.decode(encode(paidInstead).text);
  assert.equal(h.verify(good).ok, false, 'A purchase becoming a grant cannot pass');
  h.close();
});

test('grant-only choices, hero selectors and tiered entries remain strict and need no normalization', () => {
  for (const index of [2, 3, 4]) {
    const h = harness();
    const selections = structuredClone(allChoices);
    selections[index] = { granted: true };
    const good = encode(selections).text;
    assert.equal(h.decode(good).error, null);
    assert.equal(h.verify(good).ok, true);
    selections[index] = null;
    assert.equal(h.verify(encode(selections).text).ok, false, baseNodes[index].type);

    h.close();
  }
});

test('missing grant metadata and builds with no purchased entries fail closed', () => {
  const h = harness();
  const good = encode().text;
  h.decode(good);
  h.run('TEST.nodes[1001] = nil');
  assert.equal(h.verify(good).ok, false);

  h.close();
  const empty = harness();
  const grantOnly = baseNodes.map(() => null);
  grantOnly[0] = { granted: true };
  assert.equal(empty.decode(encode(grantOnly).text).error, null);
  assert.equal(empty.verify(encode(grantOnly).text).ok, false);

  empty.decode(good);
  assert.equal(empty.verify(encode(grantOnly).text).ok, false, 'An empty purchased saved tree cannot match a real build');
  empty.close();
});

test('Elemental Murder Row 79-to-77 grant omission matches while paid ranks and Farseer selection stay exact', () => {
  const specID = 262;
  const specCatalog = catalog.specs[specID];
  // Pin a public fixture so daily recommendation changes cannot alter this regression.
  const recommendation = { importString: "CYQAAAAAAAAAAAAAAAAAAAAAAAAAAAzMbbzMGjZZbZMmhZAAAAgFzsBDYAzGTgZBAmtZmZM2WMtxMjxyMzMjxsYZmZZYMzsAAMAwMjhhB" };
  const h = harness({ nodes: specCatalog.nodes, order: specCatalog.fullNodeOrder, treeID: specCatalog.traitTreeId });
  const decoded = h.decode(recommendation.importString, specID);
  assert.equal(decoded.error, null);
  assert.equal(decoded.entries.length, 79);
  const grants = decoded.entries.filter(entry => entry.ranksPurchased === 0 && entry.ranksGranted === 1);
  assert.deepEqual(grants.map(entry => [entry.nodeID, entry.selectionEntryID]), [[94888, 117485], [103598, 127873]]);
  assert.ok(grants.every(entry => {
    const node = specCatalog.nodes.find(node => node.id === entry.nodeID);
    return node.type === 'single' && node.entries.length === 1;
  }));
  assert.equal(encodeCatalogEntries(decoded.entries, specID, specCatalog), recommendation.importString,
    'Independent writer must preserve the real bundled fixture before simulating grant omission');
  const saved = decoded.entries.filter(entry => entry.ranksPurchased > 0);
  assert.equal(saved.length, 77);
  const savedString = encodeCatalogEntries(saved, specID, specCatalog);
  assert.equal(h.verify(savedString).ok, true);

  assert.equal(h.value('#result'), 79);
  const hero = saved.find(entry => entry.nodeID === 99845);
  assert.deepEqual(hero, { nodeID: 99845, selectionEntryID: 123377, ranksPurchased: 1, ranksGranted: 0 });
  const switchedHero = structuredClone(saved);
  switchedHero.find(entry => entry.nodeID === hero.nodeID).selectionEntryID = specCatalog.nodes
    .find(node => node.id === hero.nodeID).entries.find(entry => entry.id !== hero.selectionEntryID).id;
  assert.equal(h.verify(encodeCatalogEntries(switchedHero, specID, specCatalog)).ok, false);

  const omittedPurchase = saved.filter(entry => entry.nodeID !== hero.nodeID);
  assert.equal(h.verify(encodeCatalogEntries(omittedPurchase, specID, specCatalog)).ok, false);
  const changedRank = structuredClone(saved);
  const rankedEntry = changedRank.find(entry => entry.ranksPurchased > 1);
  assert.ok(rankedEntry);
  rankedEntry.ranksPurchased--;
  assert.equal(h.verify(encodeCatalogEntries(changedRank, specID, specCatalog)).ok, false);
  h.close();
});

test('choice and absent-entry verification stays strict regardless of entry order', () => {
  const h = harness();
  const good = encode().text;
  h.decode(good);
  const choices = structuredClone(allChoices);
  choices[2] = { choice: 0 };
  assert.equal(h.verify(encode(choices).text).ok, false);

  h.run('local first = table.remove(result, 1); result[#result + 1] = first');
  assert.equal(h.verify(encode(choices).text).ok, false);

  choices[2] = allChoices[2];
  choices[1] = null;
  assert.equal(h.verify(encode(choices).text).ok, false);

  h.close();
});

test('verification rejects truncated exports, unavailable exports and tree mismatch', () => {
  const h = harness();
  const good = encode().text;
  h.decode(good);
  assert.deepEqual(h.verify(good.slice(0, -2)), { ok: false, error: 'Talent string is truncated.' });

  assert.deepEqual(h.verify(''), { ok: false, error: 'The saved talent export is unavailable.' });

  assert.deepEqual(h.verify(good, 999), { ok: false, error: 'The saved talent configuration belongs to a different tree.' });

  h.close();
});

test('API exceptions and secret export values never leak or cascade through verification', () => {
  const good = encode().text;
  for (const setup of [
    'C_Traits.GenerateImportString = function() error("PRIVATE_RAW_IMPORT_STRING") end',
    'C_Traits.GenerateImportString = function() error(setmetatable({}, { __tostring = function() error("PRIVATE_RAW_IMPORT_STRING") end })) end',
    'issecretvalue = function(value) return value == TEST.exportString end',
    'C_Traits.GetNodeInfo = function() error("PRIVATE_RAW_IMPORT_STRING") end'
  ]) {
    const h = harness();
    h.decode(good);
    h.run(setup);
    const result = h.verify(good);
    assert.equal(result.ok, false, setup);
    assert.doesNotMatch(result.error, /PRIVATE_RAW_IMPORT_STRING/);
    assert.ok(result.error.length <= 160);

    h.close();
  }
});

test('invalid expected metadata and entries fail verification without throwing', () => {
  const h = harness();
  const good = encode().text;
  h.decode(good);
  h.run('metadata.specID = nil');
  assert.equal(h.verify(good).ok, false);

  h.decode(good);
  h.run('result[1].ranksPurchased = "not-a-rank"');
  assert.equal(h.verify(good).ok, false);

  h.decode(good);
  h.run('result[1] = setmetatable({}, { __index = function() error("PRIVATE_RAW_IMPORT_STRING") end })');
  assert.equal(h.verify(good).ok, false);

  h.close();
});

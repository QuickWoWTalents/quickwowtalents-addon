import test from 'node:test';
import { runImportScenario } from './helpers/talent-import-harness.mjs';

test('a stale native dropdown waits for its population update without guessing the load index', () => {
  runImportScenario(`
    assert(Start()); S.nativeStale = true; CreateImported(); Flush()
    assert(Count("load") == 0 and NS.TalentImport.GetStatus().phase == "ready"); AssertPreserved()
    S.nativeStale = false; Emit("TRAIT_CONFIG_UPDATED", 20); Flush(); Applied(); AssertComplete()
  `);
});

test('native index comes from the verified native cache even when API order differs', () => {
  runImportScenario(`
    assert(Start()); CreateImported(); S.nativeStale = true
    PlayerSpellsFrame.TalentsFrame.configIDs = {20,13,12,11,10}
    Flush(); Applied(); AssertComplete()
  `);
});

for (const setup of [
  'PlayerSpellsFrame.TalentsFrame.configIDToName[20] = "Personal"',
  'PlayerSpellsFrame.TalentsFrame.configIDs = {20,20}',
  'PlayerSpellsFrame.TalentsFrame.configurationInfo.ID = 99',
  'PlayerSpellsFrame.TalentsFrame.talentTreeID = 99',
  'PlayerSpellsFrame.TalentsFrame.variablesLoaded = false',
  'PlayerSpellsFrame.TalentsFrame.commitedConfigID = 11',
  'PlayerSpellsFrame.SpecFrame.activatedSpecIndex = 2',
  'PlayerSpellsFrame.inspectUnit = "target"',
  'PlayerSpellsFrame.inspectString = "preview"'
]) {
  test(`unsafe native state cannot switch or delete: ${setup}`, () => {
    runImportScenario(`assert(Start()); CreateImported(); S.nativeStale = true; ${setup}; Flush(); Timeout(); assert(Count("load") == 0); AssertPreserved()`);
  });
}

test('native index is checked again after a status callback changes the cached list', () => {
  runImportScenario(`
    S.statusHook = function(message) if message:find("Applying") then
      PlayerSpellsFrame.TalentsFrame.configIDs = {11,10}; S.nativeStale = true
    end end
    assert(Start()); CreateImported(); Flush(); Timeout(); assert(Count("load") == 0); AssertPreserved()
  `);
});

test('failure to load Blizzard talent support prevents creation', () => {
  runImportScenario(`PlayerSpellsFrame = nil; S.uiLoadFails = true; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
});

test('false deletion return still waits for delayed exact event plus inventory removal', () => {
  runImportScenario(`
    S.deleteReject = true; assert(Start()); CreateImported(); Flush(); Applied()
    assert(NS.TalentImport.IsBusy() and Count("delete") == 1)
    Emit("TRAIT_CONFIG_DELETED", 11); Flush(); assert(S.configs[10])
    S.configs[10] = nil; Emit("TRAIT_CONFIG_DELETED", 10); Flush(); AssertComplete()
  `);
});

test('a false return and matching event without actual removal cannot start the next deletion', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Other"); S.deleteReject = true
    S.deleteHook = function(id) Emit("TRAIT_CONFIG_DELETED", id) end
    assert(Start()); CreateImported(); Flush(); Applied(); Timeout()
    assert(Count("delete") == 1 and S.configs[10] and S.configs[15])
    assert(NS.TalentImport.GetStatus().success == false)
  `);
});

test('off-spec cleanup failure preserves that loadout and reports the remaining count', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Other spec", 263); S.rejectID = 15
    assert(Start()); CreateImported(); Flush(); Applied(); Timeout()
    local status = NS.TalentImport.GetStatus()
    assert(status.success == false and status.oldConfigID == 15 and status.remainingCount == 1)
    assert(S.spec == 262 and Count("delete") == 2 and S.configs[15])
  `);
});

test('identical encounter names on another spec cannot be reused as the requested build', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Altar of Fangs", 263); S.valid[15] = true; S.populated[15] = true
    assert(Start()); CreateImported(); Flush(); Applied()
    assert(NS.TalentImport.GetStatus().success == true and Count("import") == 1 and Count("delete") == 2)
    assert(S.configs[20] and not S.configs[15] and S.spec == 262)
  `);
});

test('managed names reject empty labels, control codes and names beyond the UTF-8 character limit', () => {
  for (const name of ['QWT-', 'QWT-|cff000000Oops', `QWT-${'A'.repeat(28)}`, `QWT-${'É'.repeat(28)}`]) {
    runImportScenario(`S.requestName = ${JSON.stringify(name)}; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
  }
});

test('save-first replacement preserves old and unrelated personal and other-spec builds until apply', () => {
  runImportScenario(`
    assert(Start())
    assert(NS.TalentImport.IsBusy())
    AssertPreserved()
    CreateImported(false); Flush()
    assert(Count("load") == 0)
    S.populated[20] = true; Emit("TRAIT_CONFIG_UPDATED", 20); Flush()
    assert(Count("load") == 1)
    AssertPreserved()
    Applied()
    AssertComplete()
  `);
});

test('synchronous created/committed/deleted events defer every following mutation', () => {
  runImportScenario(`
    S.importHook = function() CreateImported() end
    S.loadHook = function() S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1) end
    assert(Start()); Flush()
    AssertComplete()
  `);
});

test('duplicate and reordered unrelated events never duplicate import, load, selection or delete', () => {
  runImportScenario(`
    assert(Start())
    local id = CreateImported()
    for i = 1, 5 do Emit("TRAIT_CONFIG_CREATED", S.configs[id]); Emit("TRAIT_CONFIG_UPDATED", 11) end
    Flush()
    S.valid[1] = true
    for i = 1, 5 do Emit("TRAIT_CONFIG_UPDATED", 20); Emit("TRAIT_CONFIG_UPDATED", 1) end
    Flush()
    for i = 1, 5 do Emit("TRAIT_CONFIG_UPDATED", 1); Emit("TRAIT_CONFIG_DELETED", 10) end
    Flush(); Timeout()
    AssertComplete()
  `);
});

test('busy operation rejects another click without importing twice', () => {
  runImportScenario(`assert(Start()); assert(not Start()); assert(Count("import") == 1); AssertPreserved()`);
});

for (const [label, setup] of [
  ['combat', 'S.combat = true'],
  ['wrong current spec', 'S.spec = 263'],
  ['full slots', 'S.capacity = false'],
  ['talents cannot be edited', 'S.editable = false'],
  ['starter build', 'S.starter = true'],
  ['malformed import', 'S.decodeError = true'],
  ['missing codec', 'NS.TalentCodec = nil'],
  ['missing API', 'C_ClassTalents.SwitchToLoadoutByIndex = nil; C_ClassTalents.CanCreateNewConfig = nil'],
]) {
  test(`preflight ${label} makes no mutation`, () => {
    runImportScenario(`${setup}; local ok, message = Start(); assert(not ok and type(message) == "string"); assert(#S.calls == 0); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
  });
}

test('only QWT- encounter names and literal authorized prefix policy are accepted', () => {
  runImportScenario(`
    NS.Identity.loadoutPrefix = "QWTTest-"
    assert(not Start()); assert(#S.calls == 0)
    NS.Identity.loadoutPrefix = "QWT-"
    assert(not NS.TalentImport.Begin({name = "Personal", specID = 262, importString = "VALID"}))
    assert(not NS.TalentImport.Begin({name = "QWTTest-" .. string.rep("A", 24), specID = 262, importString = "VALID"}))
    assert(not NS.TalentImport.Begin({name = "QWT-", specID = 262, importString = "VALID"}))
    assert(not NS.TalentImport.Begin({name = "QWT", specID = 262, importString = "VALID"}))
    NS.Identity.managedLoadoutPrefixes = {""}; assert(not Start())
    assert(#S.calls == 0)
  `);
});

for (const mode of ['importReject', 'importThrows']) {
  test(`${mode} stops without a switch or cleanup`, () => {
    runImportScenario(`S.${mode} = true; assert(not Start()); Flush(); Timeout(); assert(Count("import") == 1 and Count("load") == 0); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
  });
}

test('population timeout keeps old and newly created builds and late events cannot resume', () => {
  runImportScenario(`assert(Start()); CreateImported(false); Flush(); Timeout(); S.populated[20] = true; Emit("TRAIT_CONFIG_UPDATED", 20); Flush(); assert(Count("load") == 0); assert(S.configs[20]); AssertPreserved(); assert(not NS.TalentImport.IsBusy())`);
});

test('multiple new same-name configs are ambiguous and never loaded', () => {
  runImportScenario(`assert(Start()); CreateImported(true, 20); CreateImported(true, 21); Flush(); assert(Count("load") == 0); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
});

test('saved contents must match requested talents before loading', () => {
  runImportScenario(`assert(Start()); CreateImported(); S.valid[20] = false; Flush(); assert(Count("load") == 0); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
});

test('current saved config is selected by ID even though old and new names match', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); assert(S.calls[3].kind == "load" and S.calls[3].id == 20); Applied(); AssertComplete()`);
});

test('accepted load or saved-config update alone never proves committed active talents', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 20); Flush(); assert(Count("select") == 0); AssertPreserved(); Timeout(); assert(Count("load") == 1)`);
});

test('active event with staged changes or mismatching active talents cannot delete old build', () => {
  runImportScenario(`
    assert(Start()); CreateImported(); Flush()
    Emit("TRAIT_CONFIG_UPDATED", 1); Flush(); AssertPreserved()
    S.valid[1] = true; S.staged[1] = true
    Emit("TRAIT_CONFIG_UPDATED", 1); Flush(); AssertPreserved()
    assert(Count("select") == 0)
    Applied(); AssertComplete()
  `);
});

test('NoChangesNecessary still verifies active talents before cleanup', () => {
  runImportScenario(`S.loadResult = 1; S.valid[1] = true; assert(Start()); CreateImported(); Flush(); AssertComplete()`);
});

test('NoChangesNecessary with wrong active tree times out without deleting', () => {
  runImportScenario(`S.loadResult = 1; assert(Start()); CreateImported(); Flush(); Timeout(); assert(Count("load") == 1); AssertPreserved()`);
});

for (const [label, setup] of [['Ready requires manual Apply', 'S.loadResult = 3'], ['Error result', 'S.loadResult = 0'], ['protected load throws', 'S.loadThrows = true']]) {
  test(`${label} preserves both builds without retrying`, () => {
    runImportScenario(`${setup}; assert(Start()); CreateImported(); Flush(); Applied(); Timeout(); assert(not NS.TalentImport.IsBusy()); assert(Count("load") == 1 and S.configs[20]); AssertPreserved()`);
  });
}

test('only matching commit failure cancels this operation', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); Emit("CONFIG_COMMIT_FAILED", 11); Flush(); assert(NS.TalentImport.IsBusy()); Emit("CONFIG_COMMIT_FAILED", 1); Applied(); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
});

for (const [label, setup] of [
  ['combat starts', 'S.combat = true; Emit("PLAYER_REGEN_DISABLED")'],
  ['specialization changes', 'S.spec = 263; Emit("PLAYER_SPECIALIZATION_CHANGED", "player")'],
  ['base config changes', 'S.active = 30; Emit("ACTIVE_COMBAT_CONFIG_CHANGED", 30)'],
]) {
  for (const stage of ['importing', 'loading']) {
    test(`${label} during ${stage} cancels subsequent mutations`, () => {
      runImportScenario(`assert(Start()); ${stage === 'loading' ? 'CreateImported(); Flush();' : ''} ${setup}; Flush(); assert(not NS.TalentImport.IsBusy()); AssertPreserved(); assert(Count("select") == 0); assert(Count("load") == ${stage === 'loading' ? 1 : 0})`);
    });
  }
}

test('non-player spec event does not cancel import', () => {
  runImportScenario(`assert(Start()); Emit("PLAYER_SPECIALIZATION_CHANGED", "party1"); CreateImported(); Flush(); Applied(); AssertComplete()`);
});

test('old name and current spec membership are checked again before deletion', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.configs[10].name = "Personal changed"; Applied(); AssertPreserved(); assert(not NS.TalentImport.IsBusy())`);
});

test('old loadout moved out of current spec is never deleted', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.configs[10].spec = 263; Applied(); AssertPreserved(); assert(not NS.TalentImport.IsBusy())`);
});

test('selection bookkeeping must read back before deletion', () => {
  runImportScenario(`S.selectReject = true; assert(Start()); CreateImported(); Flush(); Applied(); Timeout(); AssertPreserved(); assert(Count("select") == 1); assert(not NS.TalentImport.IsBusy())`);
});

test('new import without previous same-name config succeeds with no deletion', () => {
  runImportScenario(`S.configs[10] = nil; assert(Start()); CreateImported(); Flush(); Applied(); assert(not NS.TalentImport.IsBusy()); assert(NS.TalentImport.GetStatus().success == true); assert(Count("delete") == 0)`);
});

for (const mode of ['deleteReject', 'deleteThrows', 'deleteDelayed']) {
  test(`${mode} makes exactly one delete attempt and retains both builds`, () => {
    runImportScenario(`S.${mode} = true; assert(Start()); CreateImported(); Flush(); Applied(); for i = 1, 10 do Emit("TRAIT_CONFIG_UPDATED", 1); Flush() end; Timeout(); assert(Count("delete") == 1); assert(S.configs[10] and S.configs[20]); assert(not NS.TalentImport.IsBusy()); assert(NS.TalentImport.GetStatus().success == false)`);
  });
}

test('a successful delete return waits for confirmed absence from current inventory', () => {
  runImportScenario(`S.deleteDelayed = true; assert(Start()); CreateImported(); Flush(); Applied(); assert(NS.TalentImport.IsBusy()); assert(S.configs[10]); S.configs[10] = nil; Emit("TRAIT_CONFIG_DELETED", 10); Flush(); AssertComplete()`);
});

test('status callback exceptions cannot trigger retries or break the state machine', () => {
  runImportScenario(`S.statusHook = function() error("UI callback failed") end; assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()`);
});

test('callbacks that enter combat immediately before a mutation stop the operation', () => {
  runImportScenario(`S.statusHook = function(message) if message:find("Applying") then S.combat = true; Emit("PLAYER_REGEN_DISABLED") end end; assert(Start()); CreateImported(); Flush(); assert(Count("load") == 0); AssertPreserved()`);
});

test('unchanged same-name saved talents reuse the existing ID even with full slots', () => {
  runImportScenario(`S.reusing = true; S.capacity = false; S.populated[10] = true; S.valid[10] = true; assert(Start()); Flush(); assert(Count("import") == 0 and Count("bars") == 1 and Count("load") == 1); assert(S.configs[10].usesSharedActionBars == true); Applied(); assert(not NS.TalentImport.IsBusy()); assert(NS.TalentImport.GetStatus().success == true); assert(S.selected == 10); AssertPreserved()`);
});

test('unpopulated or different old talents still need a free slot', () => {
  runImportScenario(`S.capacity = false; S.valid[10] = true; assert(not Start()); S.populated[10] = true; S.valid[10] = false; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
});

test('current specialization namespace works without deprecated global functions', () => {
  runImportScenario(`C_SpecializationInfo = {GetSpecialization = GetSpecialization, GetSpecializationInfo = GetSpecializationInfo}; GetSpecialization = nil; GetSpecializationInfo = nil; assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()`);
});

test('shared action bars are set once on the new config before its one load', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); assert(Count("bars") == 1); assert(S.calls[2].kind == "bars" and S.calls[3].kind == "load"); assert(S.configs[20].usesSharedActionBars == true); for _, id in ipairs({10, 11, 12, 13, 14}) do assert(S.configs[id].usesSharedActionBars == false) end; Applied(); AssertComplete()`);
});

test('new and reused QWT loadouts already using shared bars do not rewrite their settings', () => {
  runImportScenario(`S.createdShared = true; assert(Start()); CreateImported(); Flush(); assert(Count("bars") == 0 and Count("load") == 1); Applied(); AssertComplete()`);
  runImportScenario(`S.reusing = true; S.populated[10] = true; S.valid[10] = true; S.configs[10].usesSharedActionBars = true; assert(Start()); Flush(); assert(Count("import") == 0 and Count("bars") == 0 and Count("load") == 1); Applied(); assert(NS.TalentImport.GetStatus().success == true); AssertPreserved()`);
});

for (const confirmation of ['event', 'poll']) {
  test(`shared bars wait for delayed ${confirmation} confirmation without repeating the setter`, () => {
    runImportScenario(`
      S.barsDelayed = true; assert(Start()); CreateImported(); Flush()
      assert(NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().phase == "sharing")
      assert(Count("bars") == 1 and Count("load") == 0); AssertPreserved()
      assert(Poll()); assert(Count("bars") == 1 and Count("load") == 0)
      S.configs[20].usesSharedActionBars = true
      ${confirmation === 'event' ? 'Emit("TRAIT_CONFIG_UPDATED", 20); Flush()' : 'assert(Poll())'}
      assert(Count("bars") == 1 and Count("load") == 1)
      Applied(); AssertComplete()
    `);
  });
}

test('reused QWT loadout waits for its own shared-bar confirmation before switching', () => {
  runImportScenario(`
    S.reusing = true; S.populated[10] = true; S.valid[10] = true; S.barsDelayed = true
    assert(Start()); Flush(); assert(Count("bars") == 1 and Count("load") == 0)
    S.configs[10].usesSharedActionBars = true; assert(Poll())
    assert(Count("import") == 0 and Count("bars") == 1 and Count("load") == 1)
    for _, id in ipairs({11, 12, 13, 14}) do assert(S.configs[id].usesSharedActionBars == false) end
    Applied(); assert(NS.TalentImport.GetStatus().success == true); AssertPreserved()
  `);
});

test('synchronous shared-bar events do not reenter mutations or repeat the setter', () => {
  runImportScenario(`S.barsHook = function() Emit("TRAIT_CONFIG_UPDATED", 20) end; assert(Start()); CreateImported(); Flush(); assert(Count("bars") == 1); Applied(); AssertComplete()`);
});

test('unconfirmed shared bars time out without activation, deletion, or setter retries', () => {
  runImportScenario(`
    S.barsDelayed = true; assert(Start()); CreateImported(); Flush()
    for i = 1, 5 do assert(Poll()) end
    assert(Count("bars") == 1 and Count("load") == 0 and NS.TalentImport.IsBusy())
    Timeout(); assert(not NS.TalentImport.IsBusy())
    assert(NS.TalentImport.GetStatus().message:lower():find("shared action bars", 1, true))
    assert(Count("bars") == 1 and Count("load") == 0); AssertPreserved()
  `);
});

test('missing shared-bar API refuses import before any mutation', () => {
  runImportScenario(`C_ClassTalents.SetUsesSharedActionBars = nil; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
});

test('unavailable shared-bar metadata stops before activation or deletion', () => {
  runImportScenario(`
    S.barsDelayed = true; assert(Start()); CreateImported(); Flush()
    local getInfo = C_Traits.GetConfigInfo
    C_Traits.GetConfigInfo = function(id) if id == 20 then error("metadata unavailable") end; return getInfo(id) end
    assert(Poll()); assert(not NS.TalentImport.IsBusy())
    assert(Count("bars") == 1 and Count("load") == 0); AssertPreserved()
  `);
});

for (const change of ['name', 'talents', 'population', 'combat', 'selection']) {
  test(`${change} change while waiting for shared bars prevents activation and deletion`, () => {
    const mutations = {
      name: 'S.configs[20].name = "Personal renamed"',
      talents: 'S.valid[20] = false',
      population: 'S.populated[20] = false',
      combat: 'S.combat = true',
      selection: 'S.selected = 11',
    };
    runImportScenario(`
      S.barsDelayed = true; assert(Start()); CreateImported(); Flush()
      ${mutations[change]}; S.configs[20].usesSharedActionBars = true; assert(Poll()); Timeout()
      assert(not NS.TalentImport.IsBusy() and Count("bars") == 1 and Count("load") == 0); AssertPreserved()
    `);
  });
}

test('changing shared bars after activation starts prevents cleanup of earlier loadouts', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.configs[20].usesSharedActionBars = false; Applied(); Timeout(); assert(Count("load") == 1); AssertPreserved(); assert(NS.TalentImport.GetStatus().success == false)`);
});

test('changing shared bars from the applying callback prevents the native switch', () => {
  runImportScenario(`S.statusHook = function(message) if message:find("Applying") then S.configs[20].usesSharedActionBars = false end end; assert(Start()); CreateImported(); Flush(); Timeout(); assert(Count("bars") == 1 and Count("load") == 0); AssertPreserved()`);
});

test('a status callback introducing an edit restriction prevents the shared-bar setter', () => {
  runImportScenario(`
    S.reusing = true; S.populated[10] = true; S.valid[10] = true
    S.statusHook = function(message) if message:find("Using existing") then S.editable = false end end
    assert(Start()); Flush(); assert(Count("bars") == 0 and Count("load") == 0)
    assert(NS.TalentImport.GetStatus().success == false); AssertPreserved()
  `);
});

for (const mode of ['barsReject', 'barsThrows']) {
  test(`${mode} preserves old settings and never loads the unverified new action bar configuration`, () => {
    runImportScenario(`S.${mode} = true; assert(Start()); CreateImported(); Flush(); Timeout(); assert(Count("bars") == 1 and Count("load") == 0); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
  });
}

test('missing load API fails before creating any config', () => {
  runImportScenario(`C_ClassTalents.SwitchToLoadoutByIndex = nil; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
});

test('own blocked-action event stops the operation, while another addon event does not', () => {
  runImportScenario(`assert(Start()); Emit("ADDON_ACTION_BLOCKED", "OtherAddon"); assert(NS.TalentImport.IsBusy()); Emit("ADDON_ACTION_FORBIDDEN", "QuickWoWTalents"); CreateImported(); Flush(); assert(not NS.TalentImport.IsBusy()); assert(Count("load") == 0); AssertPreserved()`);
});

test('combat entered inside the shared-actionbar API stops later mutations', () => {
  runImportScenario(`S.barsHook = function() S.combat = true; Emit("PLAYER_REGEN_DISABLED") end; assert(Start()); CreateImported(); Flush(); assert(Count("bars") == 1 and Count("load") == 0); AssertPreserved()`);
});

test('cleanup callback cannot rename old config then cause its deletion', () => {
  runImportScenario(`S.statusHook = function(message) if message:find("Finishing") then S.configs[10].name = "Personal renamed" end end; assert(Start()); CreateImported(); Flush(); Applied(); AssertPreserved()`);
});

for (const stage of ['importing', 'loading', 'cleanup']) {
  test(`another loadout selected during ${stage} is never overridden`, () => {
    runImportScenario(`
      ${stage === 'cleanup' ? 'S.statusHook = function(message) if message:find("Finishing") then S.selected = 11; Emit("SELECTED_LOADOUT_CHANGED") end end' : ''}
      assert(Start())
      ${stage !== 'importing' ? 'CreateImported(); Flush();' : ''}
      ${stage !== 'cleanup' ? 'S.selected = 11; Emit("SELECTED_LOADOUT_CHANGED"); Flush();' : ''}
      Applied()
      assert(S.selected == 11 and not NS.TalentImport.IsBusy())
      assert(Count("select") == ${stage === 'cleanup' ? 1 : 0})
      AssertPreserved()
    `);
  });
}

test('a transient unrelated selection cancels rather than restarting when it changes back', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.selected = 11; Emit("SELECTED_LOADOUT_CHANGED"); S.selected = 10; Emit("SELECTED_LOADOUT_CHANGED"); Applied(); assert(Count("select") == 0); assert(not NS.TalentImport.IsBusy()); AssertPreserved()`);
});

test('operation status tracks the live waiting phase without exposing the import string', () => {
  runImportScenario(`assert(Start()); assert(NS.TalentImport.GetStatus().phase == "importing"); CreateImported(); Flush(); local status = NS.TalentImport.GetStatus(); assert(status.phase == "loading" and status.newConfigID == 20 and status.importString == nil); Applied(); AssertComplete(); S.capacity = false; S.populated[20] = false; assert(not Start()); assert(NS.TalentImport.GetStatus().phase == "stopped")`);
});

test('old timeout callbacks cannot stop a later operation', () => {
  runImportScenario(`S.importReject = true; assert(not Start()); local oldDeadline = S.timers[1].callback; S.importReject = false; assert(Start()); oldDeadline(); assert(NS.TalentImport.IsBusy()); CreateImported(); Flush(); Applied(); assert(NS.TalentImport.GetStatus().success == true and Count("import") == 2 and Count("load") == 1 and Count("delete") == 1)`);
});

test('a callback changing staged talents cannot report successful reuse', () => {
  runImportScenario(`S.reusing = true; S.populated[10] = true; S.valid[10] = true; S.statusHook = function(message) if message:find("Finishing") then S.staged[1] = true end end; assert(Start()); Flush(); Applied(); assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == false); AssertPreserved()`);
});

test('malformed creation payload is ignored without cascading errors or repeated mutations', () => {
  runImportScenario(`assert(Start()); Emit("TRAIT_CONFIG_CREATED", {}); Emit("TRAIT_CONFIG_CREATED", 20); Flush(); assert(NS.TalentImport.IsBusy()); CreateImported(); Flush(); Applied(); AssertComplete()`);
});

for (const [parentShown, talentsShown] of [[true, true], [false, true], [true, false], [false, false]]) {
  test(`native Talents visibility: parent=${parentShown}, child=${talentsShown}`, () => {
    runImportScenario(`
      S.spellsShown = ${parentShown}; S.talentsShown = ${talentsShown}
      PlayerSpellsFrame.Hide = function() error("native frame mutated") end
      PlayerSpellsFrame.TalentsFrame.UnregisterEvent = function() error("native frame mutated") end
      assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()
    `);
  });
}

test('unloaded Blizzard player-spells UI does not prevent importing', () => {
  runImportScenario(`PlayerSpellsFrame = nil; assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()`);
});

test('opening Talents during import accepts its native activation without switching twice', () => {
  runImportScenario(`S.nativeAutoApply = true; assert(Start()); S.spellsShown = true; S.talentsShown = true; EventRegistry:TriggerEvent("PlayerSpellsFrame.TalentTab.Show"); assert(NS.TalentImport.IsBusy()); CreateImported(); Flush(); AssertNativeComplete()`);
});

test('opening Talents after creation without a registry notification still uses the native switch', () => {
  runImportScenario(`assert(Start()); CreateImported(); S.spellsShown = true; S.talentsShown = true; Flush(); Applied(); AssertComplete()`);
});

test('opening and closing Talents while applying does not interrupt the operation', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.spellsShown = true; S.talentsShown = true; EventRegistry:TriggerEvent("PlayerSpellsFrame.TalentTab.Show"); S.spellsShown = false; Applied(); AssertComplete()`);
});

test('a status callback opening Talents immediately before loading does not prevent the switch', () => {
  runImportScenario(`S.statusHook = function(message) if message:find("Applying") then S.spellsShown = true; S.talentsShown = true end end; assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()`);
});

for (const order of ['before', 'after']) {
  for (const updatedFirst of [false, true]) {
    test(`visible native creation ${order} addon listener, active update first=${updatedFirst}, adopts its activation`, () => {
      runImportScenario(`
        S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true
        S.nativeCreatedOrder = "${order}"; S.nativeUpdatedFirst = ${updatedFirst}
        PlayerSpellsFrame.Hide = function() error("native frame mutated") end
        PlayerSpellsFrame.TalentsFrame.UnregisterEvent = function() error("native listener removed") end
        S.importHook = function() CreateImported() end
        assert(Start()); assert(Count("bars") == 0 and Count("delete") == 0)
        Flush(); AssertNativeComplete()
      `);
    });
  }
}

test('visible native delayed commit stays read-only until completion and then adopts', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
    assert(Start()); CreateImported(); Flush()
    assert(NS.TalentImport.IsBusy() and Count("bars") == 0 and Count("load") == 0); AssertPreserved()
    assert(Poll()); assert(Count("bars") == 0); AssertPreserved()
    NativeCompleteImport(); Flush(); AssertNativeComplete()
  `);
});

for (const marker of ['commitedConfigID', 'autoLoadNewConfigID']) {
  test(`native ${marker} clearing without an event is observed by read-only polling`, () => {
    runImportScenario(`
      S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
      assert(Start()); CreateImported();
      PlayerSpellsFrame.TalentsFrame.commitedConfigID = nil
      PlayerSpellsFrame.TalentsFrame.${marker} = 20
      NativeCompleteImport(true); Flush()
      assert(Count("bars") == 0 and Count("load") == 0); AssertPreserved()
      PlayerSpellsFrame.TalentsFrame.${marker} = nil; S.nativeAutoTarget = nil
      assert(Poll()); AssertNativeComplete()
    `);
  });
}

test('visible native population wait never sets shared bars or switches before its commit settles', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeWaitPopulation = true
    assert(Start()); CreateImported(false); Flush(); AssertPreserved()
    S.populated[20] = true; Emit("TRAIT_CONFIG_UPDATED", 20); Flush()
    assert(Count("bars") == 0 and Count("load") == 0)
    NativeCompleteImport(); Flush(); AssertNativeComplete()
  `);
});

test('visible native matching selection without CREATED proof never authorizes a mutation', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true
    assert(Start())
    S.configs[20] = {ID = 20, name = "QWT-Altar of Fangs", type = 1, spec = 262, usesSharedActionBars = false}
    S.valid[20] = true; S.populated[20] = true
    NativeImportCreated(S.configs[20]); Flush()
    assert(NS.TalentImport.IsBusy() and Count("bars") == 0 and Count("load") == 0); AssertPreserved()
    Timeout(); assert(not NS.TalentImport.IsBusy()); AssertPreserved()
  `);
});

test('visible native early selection can finish only after matching CREATED proof arrives', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true
    assert(Start())
    S.configs[20] = {ID = 20, name = "QWT-Altar of Fangs", type = 1, spec = 262, usesSharedActionBars = false}
    S.valid[20] = true; S.populated[20] = true
    NativeImportCreated(S.configs[20]); Flush(); assert(Count("bars") == 0); AssertPreserved()
    Emit("TRAIT_CONFIG_CREATED", S.configs[20]); Flush(); AssertNativeComplete()
  `);
});

test('visible native ambiguous same-name creations cannot authorize shared bars or cleanup', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true
    assert(Start()); CreateImported(true, 20); CreateImported(true, 21); Flush(); Timeout()
    assert(not NS.TalentImport.IsBusy() and Count("bars") == 0 and Count("load") == 0); AssertPreserved()
  `);
});

for (const mismatch of ['saved', 'active', 'staged']) {
  test(`visible native activation with ${mismatch} mismatch cannot delete previous builds`, () => {
    runImportScenario(`
      S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
      assert(Start()); CreateImported(); NativeCompleteImport()
      ${mismatch === 'saved' ? 'S.valid[20] = false' : mismatch === 'active' ? 'S.valid[1] = false' : 'S.staged[1] = true'}
      Flush(); Timeout(); assert(not NS.TalentImport.IsBusy()); AssertPreserved()
    `);
  });
}

for (const marker of ['commitedConfigID', 'autoLoadNewConfigID']) {
  test(`unrelated native ${marker} in progress cannot be adopted or overwritten`, () => {
    runImportScenario(`
      S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
      assert(Start()); CreateImported(); PlayerSpellsFrame.TalentsFrame.${marker} = 11; Flush(); Timeout()
      assert(Count("bars") == 0 and Count("load") == 0 and not NS.TalentImport.IsBusy()); AssertPreserved()
    `);
  });
  test(`pre-existing native ${marker} prevents import creation`, () => {
    runImportScenario(`PlayerSpellsFrame.TalentsFrame.${marker} = 11; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
  });
}

test('a transient unrelated selection before CREATED cancels even when native activation follows', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true
    assert(Start()); S.selected = 11; Emit("SELECTED_LOADOUT_CHANGED"); CreateImported(); Flush(); Timeout()
    assert(not NS.TalentImport.IsBusy() and Count("bars") == 0 and Count("load") == 0); AssertPreserved()
  `);
});

test('a native commit that never settles times out without modifying shared bars or old loadouts', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
    assert(Start()); CreateImported(); Flush(); assert(Poll()); Timeout()
    assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == false)
    assert(Count("bars") == 0 and Count("load") == 0); AssertPreserved()
  `);
});

test('a rejected import return cannot authorize cleanup after synchronous native activation', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.importReject = true
    S.importHook = function() CreateImported() end
    assert(not Start()); Flush(); Timeout()
    assert(S.selected == 20 and S.valid[1] and Count("native-auto-load") == 1)
    assert(Count("bars") == 0 and Count("load") == 0 and not NS.TalentImport.IsBusy()); AssertPreserved()
  `);
});

test('target commit failure before CREATED reaches QWT stops without follow-up mutations', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
    S.importHook = function()
      S.configs[20] = {ID = 20, name = "QWT-Altar of Fangs", type = 1, spec = 262, usesSharedActionBars = false}
      S.valid[20] = true; S.populated[20] = true
      NativeImportCreated(S.configs[20])
      Emit("CONFIG_COMMIT_FAILED", 20)
      Emit("TRAIT_CONFIG_CREATED", S.configs[20])
    end
    assert(not Start()); Flush(); Timeout()
    assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == false)
    assert(Count("bars") == 0 and Count("load") == 0); AssertPreserved()
  `);
});

for (const failedResult of ['selection', 'active', 'staged']) {
  test(`owned native commit marker clearing without valid ${failedResult} result never triggers a second switch`, () => {
    runImportScenario(`
      S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true; S.nativeAutoDelayed = true
      assert(Start()); CreateImported(); Flush()
      assert(NS.TalentImport.IsBusy() and Count("bars") == 0); AssertPreserved()
      S.selected = 20; S.valid[1] = true; S.staged[1] = false
      ${failedResult === 'selection' ? 'S.selected = 10' : failedResult === 'active' ? 'S.valid[1] = false' : 'S.staged[1] = true'}
      PlayerSpellsFrame.TalentsFrame.commitedConfigID = nil; S.nativeAutoTarget = nil
      assert(Poll()); Timeout()
      assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == false)
      assert(Count("bars") == 0 and Count("load") == 0); AssertPreserved()
    `);
  });
}

for (const phase of ['Enabling shared action bars', 'Applying']) {
  test(`native commit beginning in ${phase} callback postpones mutation until confirmed completion`, () => {
    runImportScenario(`
      S.statusHook = function(message)
        if not S.nativeStarted and message:find("${phase}", 1, true) then
          S.nativeStarted = true; S.spellsShown = true; S.talentsShown = true
          S.nativeAutoApply = true; S.nativeAutoDelayed = true
          NativeImportCreated(S.configs[20])
        end
      end
      assert(Start()); CreateImported(); Flush()
      assert(S.nativeStarted and NS.TalentImport.IsBusy())
      assert(Count("bars") == ${phase === 'Applying' ? 1 : 0} and Count("load") == 0); AssertPreserved()
      NativeCompleteImport(); Flush(); AssertNativeComplete()
    `);
  });
}

for (const setup of [
  'PlayerSpellsFrame.SpecFrame.activatedSpecIndex = 2',
  'PlayerSpellsFrame.inspectUnit = "target"',
  'PlayerSpellsFrame.inspectString = "preview"',
]) {
  test(`pre-existing native transition or inspection prevents import: ${setup}`, () => {
    runImportScenario(`${setup}; assert(not Start()); assert(#S.calls == 0); AssertPreserved()`);
  });
}

test('reusing a verified saved loadout while Talents is open still uses the public native switch once', () => {
  runImportScenario(`
    S.spellsShown = true; S.talentsShown = true; S.nativeAutoApply = true
    S.reusing = true; S.populated[10] = true; S.valid[10] = true
    assert(Start()); Flush(); assert(Count("import") == 0 and Count("load") == 1 and Count("bars") == 1)
    Applied(); assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == true)
    assert(Count("native-auto-load") == 0 and Count("load") == 1); AssertPreserved()
  `);
});

test('native edit restriction is reported precisely without claiming pending changes', () => {
  runImportScenario(`S.editable = false; S.editError = "You cannot change talents during a Mythic Keystone dungeon."; local ok, message = Start(); assert(not ok and message:find(S.editError, 1, true)); assert(not message:find("pending")); assert(#S.calls == 0); AssertPreserved()`);
});

test('initial pending or incomplete talents are replaced through the native switch before cleanup', () => {
  runImportScenario(`
    S.staged[1] = true; S.valid[1] = false
    C_ClassTalents.CanChangeTalents = function() error("current staged build must not gate replacement") end
    assert(Start()); assert(Count("import") == 1 and S.staged[1]); AssertPreserved()
    CreateImported(); Flush()
    assert(Count("load") == 1 and S.staged[1] and not S.valid[1]); AssertPreserved()
    Applied(); AssertComplete()
  `);
});

test('pending edits introduced while Blizzard talent support loads do not block replacement', () => {
  runImportScenario(`
    PlayerSpellsFrame = nil
    S.uiLoadHook = function() S.staged[1] = true end
    assert(Start()); assert(S.staged[1] and Count("import") == 1)
    CreateImported(); Flush(); assert(Count("load") == 1); AssertPreserved()
    Applied(); AssertComplete()
  `);
});

test('pending edits present before the ready phase do not block the native target switch', () => {
  runImportScenario(`
    assert(Start()); CreateImported(); S.staged[1] = true; Flush()
    assert(Count("load") == 1 and S.staged[1]); AssertPreserved()
    Applied(); AssertComplete()
  `);
});

test('native acceptance with uncleared pending edits times out without deleting any old build', () => {
  runImportScenario(`
    S.staged[1] = true; assert(Start()); CreateImported(); Flush()
    S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1); Flush()
    assert(NS.TalentImport.IsBusy() and Count("load") == 1 and S.staged[1]); AssertPreserved()
    Timeout(); assert(NS.TalentImport.GetStatus().success == false and Count("load") == 1)
    AssertPreserved()
  `);
});

test('NoChangesNecessary cannot complete or delete while the matching target remains staged', () => {
  runImportScenario(`
    S.staged[1] = true; S.valid[1] = true; S.loadResult = 1
    assert(Start()); CreateImported(); Flush()
    assert(S.selected == 20 and NS.TalentImport.IsBusy() and S.staged[1]); AssertPreserved()
    Timeout(); assert(NS.TalentImport.GetStatus().success == false and Count("load") == 1)
    AssertPreserved()
  `);
});

test('a rejected import leaves the initial pending edits and previous builds untouched', () => {
  runImportScenario(`
    S.staged[1] = true; S.importReject = true
    assert(not Start()); Flush(); Timeout()
    assert(S.staged[1] and Count("import") == 1 and Count("load") == 0)
    AssertPreserved()
  `);
});

test('an invalid saved target is never applied over the initial pending edits', () => {
  runImportScenario(`
    S.staged[1] = true; assert(Start()); CreateImported(); S.valid[20] = false; Flush()
    assert(S.staged[1] and Count("load") == 0 and NS.TalentImport.GetStatus().success == false)
    AssertPreserved()
  `);
});

test('failed native replacement of pending edits preserves every old build and cannot resume on a late event', () => {
  runImportScenario(`
    S.staged[1] = true; assert(Start()); CreateImported(); Flush()
    Emit("CONFIG_COMMIT_FAILED", 1); Flush()
    assert(NS.TalentImport.GetStatus().success == false and S.configs[20]); AssertPreserved()
    Applied(); Timeout()
    assert(Count("load") == 1 and not NS.TalentImport.IsBusy()); AssertPreserved()
  `);
});

test('missing active configuration reports availability rather than pending changes', () => {
  runImportScenario(`S.active = nil; local ok, message = Start(); assert(not ok and message:find("active talent configuration is unavailable")); assert(not message:find("pending")); assert(#S.calls == 0); AssertPreserved()`);
});

test('an edit restriction arriving after import preserves its native reason and stops before load', () => {
  runImportScenario(`assert(Start()); CreateImported(); S.editable = false; S.editError = "You are not in a rested area."; Flush(); assert(Count("load") == 0); local message = NS.TalentImport.GetStatus().message; assert(message:find(S.editError, 1, true) and not message:find("pending")); AssertPreserved()`);
});

test('one canonical QWT replaces both legacy prefixes and duplicate canonical names after verified application', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Altar"); AddManaged(16, "QWTTest-Murder Row"); AddManaged(17, "QWT")
    assert(Start()); assert(NS.TalentImport.GetStatus().remainingCount == 4)
    CreateImported(); Flush(); assert(Count("delete") == 0)
    Applied(); assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == true)
    assert(NS.TalentImport.GetStatus().remainingCount == 0)
    assert(Count("import") == 1 and Count("load") == 1 and Count("delete") == 4)
    for _, id in ipairs({10,15,16,17}) do assert(not S.configs[id] and S.deleteCounts[id] == 1) end
    for _, id in ipairs({1,11,12,13,14,20}) do assert(S.configs[id]) end
    assert(S.configs[20].name == "QWT-Altar of Fangs" and S.selected == 20)
  `);
});

test('full slots reuse the selected matching canonical QWT and consolidate the other managed snapshots', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Boss"); AddManaged(16, "QWT-Altar of Fangs"); AddManaged(17, "QWTTest-Old")
    S.valid[10] = true; S.populated[10] = true; S.valid[16] = true; S.populated[16] = true
    S.selected = 16; S.expectedLoadID = 16; S.capacity = false
    assert(Start()); Flush(); assert(Count("import") == 0 and Count("bars") == 1 and Count("load") == 1)
    Applied(); assert(NS.TalentImport.GetStatus().success == true and S.selected == 16)
    assert(Count("delete") == 3 and S.configs[16] and not S.configs[20])
    for _, id in ipairs({10,15,17}) do assert(not S.configs[id] and S.deleteCounts[id] == 1) end
  `);
});

test('canonical reuse chooses the lowest matching ID when the selected loadout is personal', () => {
  runImportScenario(`
    AddManaged(8, "QWT-Altar of Fangs"); AddManaged(9, "QWT-Altar of Fangs")
    S.populated[8] = true; S.valid[8] = false
    S.populated[9] = true; S.valid[9] = true
    S.populated[10] = true; S.valid[10] = true
    S.selected = 11; S.expectedLoadID = 9; S.capacity = false
    assert(Start()); Flush(); Applied()
    assert(NS.TalentImport.GetStatus().success == true and S.selected == 9)
    assert(S.configs[9] and S.configs[11] and not S.configs[8] and not S.configs[10])
    assert(Count("import") == 0 and Count("load") == 1 and Count("delete") == 2)
  `);
});

test('matching legacy names are not reused and full slots never trigger pre-deletion', () => {
  runImportScenario(`S.configs[10].name = "QWTTest-Old"; S.valid[10] = true; S.populated[10] = true; AddManaged(15, "QWT-Other"); S.capacity = false; assert(not Start()); assert(#S.calls == 0); AssertPreserved(); assert(S.configs[15])`);
});

test('prefix lookalikes remain personal and managed names across character specs are consolidated', () => {
  runImportScenario(`
    for index, name in ipairs({"My QWT", "QWTpersonal", "qwt-Old", "QWTTest", " QWT", "QWT ", "My QWT-Old"}) do AddManaged(30 + index, name) end
    AddManaged(40, "QWT", 263); AddManaged(41, "QWT-Other spec", 263)
    assert(Start()); CreateImported(); Flush(); Applied()
    assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 3)
    assert(S.spec == 262 and S.configs[14] and S.configs[20])
    for id = 31, 37 do assert(S.configs[id] and not S.deleteCounts[id]) end
    assert(not S.configs[40] and not S.configs[41] and S.deleteCounts[40] == 1 and S.deleteCounts[41] == 1)
  `);
});

for (const [label, setup] of [
  ['noncombat', 'S.configs[10].type = 2'],
  ['not a saved config', 'S.unsavedIDs = {[10] = true}'],
]) {
  test(`${label} reserved names stop before mutations rather than claiming consolidation`, () => {
    runImportScenario(`${setup}; assert(not Start()); assert(#S.calls == 0 and S.configs[10] and not S.configs[20]); AssertPreserved()`);
  });
}

test('spec membership comes from the spec inventory and never an undocumented config-info field', () => {
  runImportScenario(`S.hideSpec = true; AddManaged(15, "QWT-Old"); assert(Start()); CreateImported(); Flush(); Applied(); assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 2 and not S.configs[15] and S.configs[14])`);
});

test('base active config is never enrolled even when it appears in the saved ID list with a managed name', () => {
  runImportScenario(`S.includeBase = true; S.configs[1].name = "QWT"; assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete(); assert(S.configs[1])`);
});

test('delayed cleanup confirms each particular ID absent before issuing the next deletion', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); AddManaged(16, "QWTTest-Old"); S.deleteDelayed = true
    assert(Start()); CreateImported(); Flush(); Applied()
    assert(Count("delete") == 1 and NS.TalentImport.GetStatus().oldConfigID == 10)
    Emit("TRAIT_CONFIG_DELETED", 15); Emit("TRAIT_CONFIG_DELETED", 10); Flush()
    assert(Count("delete") == 1 and NS.TalentImport.GetStatus().remainingCount == 3)
    S.configs[10] = nil; Emit("TRAIT_CONFIG_DELETED", 10); Flush()
    assert(Count("delete") == 2 and NS.TalentImport.GetStatus().oldConfigID == 15 and S.configs[16])
    S.configs[15] = nil; Emit("TRAIT_CONFIG_DELETED", 15); Flush()
    assert(Count("delete") == 3 and NS.TalentImport.GetStatus().remainingCount == 1)
    S.configs[16] = nil; Emit("TRAIT_CONFIG_DELETED", 16); Flush(); Timeout()
    assert(NS.TalentImport.GetStatus().success == true and NS.TalentImport.GetStatus().remainingCount == 0)
    for _, id in ipairs({10,15,16}) do assert(S.deleteCounts[id] == 1) end
  `);
});

test('synchronous confirmed deletion followed by a false API return advances exactly once', () => {
  runImportScenario(`AddManaged(15, "QWT-Old"); S.deleteHook = function(id) S.configs[id] = nil; Emit("TRAIT_CONFIG_DELETED", id); S.rejectID = id end; assert(Start()); CreateImported(); Flush(); Applied(); Timeout(); assert(Count("delete") == 2 and not S.configs[15]); assert(NS.TalentImport.GetStatus().success == true)`);
});

for (const mode of ['rejectID', 'throwID']) {
  test(`a second cleanup ${mode} keeps all later IDs without retrying the first or second`, () => {
    runImportScenario(`AddManaged(15, "QWT-Old"); AddManaged(16, "QWTTest-Old"); S.${mode} = 15; assert(Start()); CreateImported(); Flush(); Applied(); for i = 1, 5 do Emit("TRAIT_CONFIG_UPDATED", 1); Flush() end; Timeout(); assert(Count("delete") == 2 and not S.configs[10] and S.configs[15] and S.configs[16]); assert(S.deleteCounts[10] == 1 and S.deleteCounts[15] == 1 and not S.deleteCounts[16]); local status = NS.TalentImport.GetStatus(); assert(status.success == false and status.oldConfigID == 15 and status.remainingCount == 2)`);
  });
}

for (const [label, change] of [
  ['combat', 'S.combat = true; Emit("PLAYER_REGEN_DISABLED")'],
  ['spec change', 'S.spec = 263; Emit("PLAYER_SPECIALIZATION_CHANGED", "player")'],
  ['selection change', 'S.selected = 11; Emit("SELECTED_LOADOUT_CHANGED")'],
  ['active base change', 'S.active = 30; Emit("ACTIVE_COMBAT_CONFIG_CHANGED", 30)'],
  ['staged changes', 'S.staged[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1)'],
  ['changed applied build', 'S.valid[1] = false; Emit("TRAIT_CONFIG_UPDATED", 1)'],
]) {
  test(`${label} after one confirmed removal stops later cleanup`, () => {
    runImportScenario(`
      AddManaged(15, "QWT-Old"); AddManaged(16, "QWTTest-Old")
      assert(Start()); CreateImported(); Flush(); S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1)
      while Count("delete") == 0 do assert(Step()) end
      assert(not S.configs[10]); ${change}; Flush(); Timeout()
      assert(Count("delete") == 1 and S.configs[15] and S.configs[16] and S.configs[20])
      assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == false)
      assert(not NS.TalentImport.GetStatus().message:find("Existing loadouts were kept", 1, true))
    `);
  });
}

test('opening Talents after one confirmed removal allows verified cleanup to continue', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); AddManaged(16, "QWTTest-Old")
    assert(Start()); CreateImported(); Flush(); S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1)
    while Count("delete") == 0 do assert(Step()) end
    S.spellsShown = true; S.talentsShown = true; EventRegistry:TriggerEvent("PlayerSpellsFrame.TalentTab.Show")
    Flush(); assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 3)
    for _, id in ipairs({10,15,16}) do assert(not S.configs[id] and S.deleteCounts[id] == 1) end
    for _, id in ipairs({11,12,13,14,20}) do assert(S.configs[id]) end
  `);
});

for (const [label, change] of [
  ['renamed personal', 'S.configs[16].name = "Personal now"'],
  ['renamed still managed', 'S.configs[16].name = "QWT-Renamed"'],
  ['moved to another spec', 'S.configs[16].spec = 263'],
  ['no longer saved', 'S.unsavedIDs = {[16] = true}'],
]) {
  test(`remaining snapshot ${label} stops all further cleanup`, () => {
    runImportScenario(`
      AddManaged(15, "QWT-Old"); AddManaged(16, "QWTTest-Old")
      assert(Start()); CreateImported(); Flush(); S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1)
      while Count("delete") == 0 do assert(Step()) end
      ${change}; Flush(); Timeout()
      assert(Count("delete") == 1 and S.configs[15] and S.configs[16]); assert(NS.TalentImport.GetStatus().success == false)
    `);
  });
}

for (const name of ['QWT', 'QWT-New', 'QWTTest-New']) {
  test(`post-snapshot ${name} creation stops cleanup and is never swept into it`, () => {
    runImportScenario(`AddManaged(15, "QWT-Old"); assert(Start()); CreateImported(); Flush(); AddManaged(30, "${name}"); Applied(); Timeout(); assert(Count("delete") == 0 and S.configs[30] and S.configs[15]); assert(NS.TalentImport.GetStatus().success == false and NS.TalentImport.GetStatus().message:find("Another managed loadout")); AssertPreserved()`);
  });
}

test('personal snapshot ID renamed into QWT scope is not silently enrolled', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.configs[11].name = "QWT-New"; Applied(); assert(Count("delete") == 0 and S.configs[11]); assert(NS.TalentImport.GetStatus().success == false); AssertPreserved()`);
});

test('externally removed snapshot IDs are skipped without issuing a redundant deletion', () => {
  runImportScenario(`AddManaged(15, "QWT-Old"); assert(Start()); CreateImported(); Flush(); S.configs[10] = nil; Emit("TRAIT_CONFIG_DELETED", 10); Applied(); assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 1 and S.deleteCounts[15] == 1 and not S.deleteCounts[10])`);
});

test('unrelated new personal ID does not interrupt consolidation or become a cleanup target', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); AddManaged(30, "Personal new"); Applied(); AssertComplete(); assert(S.configs[30] and not S.deleteCounts[30])`);
});

test('an unsafe legacy reserved name stops preflight without deleting or importing', () => {
  runImportScenario(`AddManaged(15, "QWTTest-Old"); S.configs[15].type = 2; assert(not Start()); assert(#S.calls == 0 and S.configs[15]); AssertPreserved()`);
});

test('a newly appearing unsafe reserved name still stops cleanup instead of claiming only one remains', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); AddManaged(30, "QWT-Later"); S.configs[30].type = 2; Applied(); assert(NS.TalentImport.GetStatus().success == false and S.configs[30]); AssertPreserved()`);
});

test('completion status clears the current removal ID after its confirmed deletion', () => {
  runImportScenario(`assert(Start()); CreateImported(); Flush(); S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1); while Count("delete") == 0 do assert(Step()) end; assert(Step()); local status = NS.TalentImport.GetStatus(); assert(status.phase == "cleanup" and status.remainingCount == 0 and status.oldConfigID == nil); Flush(); AssertComplete()`);
});

test('confirmed deletions continue sequentially even when config metadata stays cached indefinitely', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); AddManaged(16, "QWTTest-Old"); S.retainDeletedInfo = true
    assert(Start()); CreateImported(); Flush(); Applied(); Timeout()
    assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 3)
    for _, id in ipairs({10, 15, 16}) do
      assert(not S.configs[id] and C_Traits.GetConfigInfo(id) and S.deleteCounts[id] == 1)
    end
    assert(S.configs[20] and not QuickWoWTalentsDB.cleanupDiagnostic)
  `);
});

test('list removal before a delayed matching deletion event waits without retrying or trusting cached metadata', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); S.retainDeletedInfo = true; S.omitDeleteEvent = true
    assert(Start()); CreateImported(); Flush(); Applied()
    assert(NS.TalentImport.IsBusy() and Count("delete") == 1 and not S.configs[10])
    Emit("TRAIT_CONFIG_DELETED", 15); Emit("TRAIT_CONFIG_LIST_UPDATED"); Flush()
    assert(Count("delete") == 1 and S.configs[15])
    Emit("TRAIT_CONFIG_DELETED", 10); Flush()
    assert(Count("delete") == 2 and NS.TalentImport.GetStatus().oldConfigID == 15)
    Emit("TRAIT_CONFIG_DELETED", 10); Emit("TRAIT_CONFIG_LIST_UPDATED"); Flush()
    assert(NS.TalentImport.IsBusy() and Count("delete") == 2)
    Emit("TRAIT_CONFIG_DELETED", 15); Flush(); Timeout()
    assert(NS.TalentImport.GetStatus().success == true and S.deleteCounts[10] == 1 and S.deleteCounts[15] == 1)
  `);
});

test('matching deletion event before list removal waits for membership to disappear', () => {
  runImportScenario(`
    S.deleteDelayed = true; assert(Start()); CreateImported(); Flush(); Applied()
    Emit("TRAIT_CONFIG_DELETED", 10); Flush()
    assert(NS.TalentImport.IsBusy() and S.configs[10] and Count("delete") == 1)
    S.cachedConfigs[10] = S.configs[10]; S.configs[10] = nil
    Emit("TRAIT_CONFIG_LIST_UPDATED"); Flush(); AssertComplete()
    assert(C_Traits.GetConfigInfo(10) and S.deleteCounts[10] == 1)
  `);
});

for (const retained of [false, true]) {
  test(`absent ID without its deletion event times out safely with retained metadata=${retained}`, () => {
    runImportScenario(`
      AddManaged(15, "QWT-Old"); S.omitDeleteEvent = true; S.retainDeletedInfo = ${retained}
      assert(Start()); Emit("TRAIT_CONFIG_DELETED", 10); CreateImported(); Flush(); Applied()
      for _, id in ipairs({15, 999}) do Emit("TRAIT_CONFIG_DELETED", id) end
      Emit("TRAIT_CONFIG_DELETED"); Emit("TRAIT_CONFIG_LIST_UPDATED"); Flush()
      assert(NS.TalentImport.IsBusy() and Count("delete") == 1 and S.configs[15])
      Timeout(); local status = NS.TalentImport.GetStatus()
      assert(status.success == false and status.phase == "stopped")
      assert(status.oldConfigID == 10 and status.newConfigID == 20 and status.remainingCount == 2)

      Emit("TRAIT_CONFIG_DELETED", 10); Flush(); assert(Count("delete") == 1)
    `);
  });
}

test('an attempted ID appearing under another spec without a deletion event never advances cleanup', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); S.deleteDelayed = true
    assert(Start()); CreateImported(); Flush(); Applied()
    S.configs[10].spec = 263; Emit("TRAIT_CONFIG_LIST_UPDATED"); Flush(); Timeout()
    local status = NS.TalentImport.GetStatus()
    assert(status.success == false and Count("delete") == 1 and S.configs[10] and S.configs[15])

    assert(not status.message:find("changed specialization during cleanup", 1, true))
  `);
});

test('a false deletion return with exact event and absent membership succeeds despite cached metadata', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old")
    S.deleteHook = function(id)
      S.cachedConfigs[id] = S.configs[id]; S.configs[id] = nil
      Emit("TRAIT_CONFIG_DELETED", id); S.rejectID = id
    end
    assert(Start()); CreateImported(); Flush(); Applied(); Timeout()
    assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 2 and not S.configs[15])
  `);
});

test('cleanup API read failures cannot cascade or expose exception text', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); S.deleteDelayed = true
    assert(Start()); CreateImported(); Flush(); Applied()
    C_ClassTalents.GetConfigIDsBySpecID = function() error("PRIVATE INVENTORY") end
    C_Traits.GetConfigInfo = function() error("PRIVATE METADATA") end
    Timeout(); local status = NS.TalentImport.GetStatus()
    assert(not NS.TalentImport.IsBusy() and status.success == false and Count("delete") == 1)
    assert(status.oldConfigID == 10)
    assert(not status.message:find("PRIVATE"))
  `);
});

test('cleanup interrupted between deletions preserves the next candidate', () => {
  runImportScenario(`
    AddManaged(15, "QWT-Old"); assert(Start()); CreateImported(); Flush()
    S.valid[1] = true; Emit("TRAIT_CONFIG_UPDATED", 1)
    while Count("delete") == 0 do assert(Step()) end
    assert(Step()); assert(NS.TalentImport.GetStatus().oldConfigID == 15)
    S.combat = true; Emit("PLAYER_REGEN_DISABLED"); Flush()
    local status = NS.TalentImport.GetStatus()
    assert(status.success == false and status.oldConfigID == 15 and status.remainingCount == 1)

    assert(Count("delete") == 1 and S.configs[15])
  `);
});

for (const order of ['before', 'after']) {
  test(`hidden native loadout list handles real deletion events ${order} the addon listener`, () => {
    runImportScenario(`
      S.nativeDeletedOrder = "${order}"
      AddManaged(15, "QWT-Other")
      assert(Start()); CreateImported(); Flush(); Applied()
      assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 2)
      local ids = {}; for _, id in ipairs(PlayerSpellsFrame.TalentsFrame.configIDs) do ids[id] = true end
      assert(not ids[10] and not ids[15] and ids[20] and ids[11])
      assert(S.nativeDeleteRefreshes == 2 and not S.nativeEvents.TRAIT_CONFIG_DELETED)
      assert(CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
      assert((S.directNativeCalls or 0) == 0)
      assert(Count("load") == 1 and Count("select") == 1)
    `);
  });
}

test('native deletion support is scoped to applied cleanup with an actual removal', () => {
  runImportScenario(`
    assert(Start()); CreateImported(); Flush()
    assert(#S.nativeRegistrationCalls == 0 and CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
    Applied(); AssertComplete()
    assert(#S.nativeRegistrationCalls == 2 and not S.nativeEvents.TRAIT_CONFIG_DELETED)
    assert(CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
  `);
  runImportScenario(`
    S.configs[10] = nil; assert(Start()); CreateImported(); Flush(); Applied()
    assert(NS.TalentImport.GetStatus().success == true and Count("delete") == 0)
    assert(#S.nativeRegistrationCalls == 0 and CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
  `);
});

test('hiding native Talents during delayed cleanup restores its real deletion listener', () => {
  runImportScenario(`
    SetNativeVisibility(true); S.deleteDelayed = true
    assert(Start()); CreateImported(); Flush(); Applied()
    assert(#S.nativeRegistrationCalls == 0 and S.nativeEvents.TRAIT_CONFIG_DELETED)
    SetNativeVisibility(false)
    assert(S.nativeEvents.TRAIT_CONFIG_DELETED and #S.nativeRegistrationCalls == 1)
    S.configs[10] = nil; Emit("TRAIT_CONFIG_DELETED", 10); Flush(); AssertComplete()
    for _, id in ipairs(PlayerSpellsFrame.TalentsFrame.configIDs) do assert(id ~= 10) end
    assert(not S.nativeEvents.TRAIT_CONFIG_DELETED and #S.nativeRegistrationCalls == 2)
    assert(CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
    assert((S.directNativeCalls or 0) == 0)
  `);
});

test('showing native Talents while cleanup waits retains the native-owned listener', () => {
  runImportScenario(`
    S.deleteDelayed = true; assert(Start()); CreateImported(); Flush(); Applied()
    assert(S.nativeEvents.TRAIT_CONFIG_DELETED and #S.nativeRegistrationCalls == 1)
    SetNativeVisibility(true)
    S.configs[10] = nil; Emit("TRAIT_CONFIG_DELETED", 10); Flush(); AssertComplete()
    assert(S.nativeEvents.TRAIT_CONFIG_DELETED and #S.nativeRegistrationCalls == 1)
    assert(CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
    SetNativeVisibility(false); assert(not S.nativeEvents.TRAIT_CONFIG_DELETED)
    assert(#S.nativeRegistrationCalls == 1)
  `);
});

for (const stop of ['combat', 'timeout']) {
  test(`${stop} releases only the temporary hidden deletion listener and hide callback`, () => {
    runImportScenario(`
      S.deleteDelayed = true; assert(Start()); CreateImported(); Flush(); Applied()
      assert(S.nativeEvents.TRAIT_CONFIG_DELETED and CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 1)
      ${stop === 'combat' ? 'S.combat = true; Emit("PLAYER_REGEN_DISABLED")' : 'Timeout()'}
      assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == false)
      assert(not S.nativeEvents.TRAIT_CONFIG_DELETED and CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 0)
      SetNativeVisibility(false); assert(not S.nativeEvents.TRAIT_CONFIG_DELETED)
      assert(S.configs[10] and S.configs[20] and Count("delete") == 1)
    `);
  });
}

test('an existing hidden native listener and unrelated Hide callback retain their ownership', () => {
  runImportScenario(`
    S.nativeEvents.TRAIT_CONFIG_DELETED = true
    local otherOwner = {}; local hideCount = 0
    EventRegistry:RegisterCallback("PlayerSpellsFrame.TalentTab.Hide", function() hideCount = hideCount + 1 end, otherOwner)
    assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()
    assert(S.nativeEvents.TRAIT_CONFIG_DELETED and #S.nativeRegistrationCalls == 0)
    assert(CallbackCount("PlayerSpellsFrame.TalentTab.Hide") == 1)
    EventRegistry:TriggerEvent("PlayerSpellsFrame.TalentTab.Hide")
    assert(hideCount == 1 and Count("delete") == 1)
  `);
});

for (const setup of [
  'PlayerSpellsFrame.TalentsFrame.IsEventRegistered = nil',
  'PlayerSpellsFrame.TalentsFrame.RegisterEvent = nil',
  'PlayerSpellsFrame.TalentsFrame.UnregisterEvent = nil',
  'PlayerSpellsFrame.TalentsFrame.IsVisible = nil',
  'EventRegistry = nil',
  'EventRegistry.RegisterCallback = nil',
  'EventRegistry.UnregisterCallback = nil',
  'S.nativeEventCheckThrows = true',
  'S.nativeRegisterThrows = true',
  'S.nativeUnregisterThrows = true',
  'S.nativeVisibilityThrows = true',
  'S.registryRegisterThrows = true',
  'S.registryUnregisterThrows = true',
]) {
  test(`optional native deletion presentation failure preserves verified cleanup: ${setup}`, () => {
    runImportScenario(`
      ${setup}
      assert(Start()); CreateImported(); Flush(); Applied(); AssertComplete()
      assert((S.directNativeCalls or 0) == 0)
      assert(S.configs[11] and S.configs[12] and S.configs[13] and S.configs[14])
    `);
  });
}

test('verification failure reports the reason and preserves loadouts without saved debug records', () => {
  runImportScenario(`
    S.verifyReason = "Imported talent entries differ."
    assert(Start()); CreateImported(); S.valid[20] = false; Flush()
    local status = NS.TalentImport.GetStatus()
    assert(status.success == false and status.message:find(S.verifyReason, 1, true))
    assert(status.diagnostics == nil and status.cleanupDiagnostics == nil)
    assert(QuickWoWTalentsDB.importDiagnostic == nil and QuickWoWTalentsDB.cleanupDiagnostic == nil)
    assert(QuickWoWTalentsDB.debug == nil and QuickWoWTalentsDB.autoOpenEnabled == false)
    AssertPreserved(); assert(Count("load") == 0)
  `);
});

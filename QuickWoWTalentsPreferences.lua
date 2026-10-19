local _, ns = ...

local Preferences = {}
ns.Preferences = Preferences

-- Semantic keys persist across addon/data updates. IDs are only an allowlist:
-- every pair is checked against the running client's trait definitions before use.
local definitions = {}
local function Add(key, label, specs, nodeID, category, description, first, second, advanced)
  local definition = { key = key, label = label, specs = specs, nodeID = nodeID,
    category = category, description = description, advanced = advanced == true,
    choices = { { key = "recommended", label = "Use recommended" }, first, second } }
  definitions[#definitions + 1] = definition
end

local function Choice(key, label, entryID, spellID)
  return { key = key, label = label, entryID = entryID, spellID = spellID }
end

Add("earthquakeTargeting", "Earthquake", { 262 }, 80985, "targeting",
  "Choose where Earthquake lands. Ground placement allows positioning before enemies arrive.",
  Choice("target", "At my target", 101855, 462620), Choice("ground", "Choose ground location", 127925, 61882))
Add("flamestrikeTargeting", "Flamestrike", { 63 }, 109409, "targeting",
  "Choose where Flamestrike lands. Placement changes which enemies are hit.",
  Choice("target", "At my target", 135602, 1254851), Choice("ground", "Choose ground location", 135619, 2120))
Add("blizzardTargeting", "Blizzard", { 64 }, 108864, "targeting",
  "Choose where Blizzard lands. Ground placement gives control over its position.",
  Choice("target", "At my target", 134538, 1248829), Choice("ground", "Choose ground location", 134421, 190356))
Add("rainOfFireTargeting", "Rain of Fire", { 267 }, 72069, "targeting",
  "Choose where Rain of Fire lands. Ground placement gives control over its position.",
  Choice("target", "At my target", 128601, 1214467), Choice("ground", "Choose ground location", 91592, 5740))
Add("thistleTeaActivation", "Thistle Tea", { 259, 260, 261 }, 90756, "activation",
  "Automatic use still permits manual activation. Manual-only use changes Energy timing and can affect performance.",
  Choice("automatic", "Automatic + manual", 112648, 469779), Choice("manual", "Manual only", 137464, 1298826), true)
Add("mageMovement", "Blink", { 62, 63, 64 }, 62105, "movement",
  "Changes teleport behavior and cooldowns. Choose the movement option you prefer.",
  Choice("shimmer", "Shimmer", 80163, 212653), Choice("improvedBlink", "Improved Blink", 134197, 1244340), true)
Add("monkMovement", "Roll", { 268, 269, 270 }, 101183, "movement",
  "Changes your movement ability and travel distance.",
  Choice("celerity", "Celerity", 124982, 115173), Choice("chiTorpedo", "Chi Torpedo", 124981, 115008), true)
Add("druidMovement", "Druid movement", { 102, 103, 104, 105 }, 82198, "movement",
  "Changes how you move between targets or reposition.",
  Choice("wildCharge", "Wild Charge", 103276, 102401), Choice("tigerDash", "Tiger Dash", 103275, 252216), true)
Add("shamanMovement", "Shaman movement", { 262, 263, 264 }, 103591, "movement",
  "Choose a movement speed ability or a directional leap. These provide different utility.",
  Choice("spiritWalk", "Spirit Walk", 127865, 58875), Choice("gustOfWind", "Gust of Wind", 127864, 192063), true)
Add("verdantEmbraceStyle", "Verdant Embrace", { 1468 }, 93243, "playstyle",
  "Changes Verdant Embrace movement and healing behavior. This can affect healing performance.",
  Choice("dreamSimulacrum", "Dream Simulacrum", 115546, 1241669), Choice("wingsOfLiberty", "Wings of Liberty", 133503, 1241704), true)
Add("hunterCompanion", "Hunter companion", { 253 }, 110158, "playstyle",
  "Choose two companions or one stronger companion. Pet mechanics and damage can differ.",
  Choice("animalCompanion", "Animal Companion", 136679, 267116), Choice("solitaryCompanion", "Solitary Companion", 136678, 474746), true)
Add("frostCompanion", "Water Elemental", { 64 }, 108850, "playstyle",
  "Choose a Water Elemental or Lonely Winter. This changes pet mechanics and damage.",
  Choice("waterElemental", "Summon Water Elemental", 134406, 31687), Choice("lonelyWinter", "Lonely Winter", 136839, 205024), true)

local function IsSecret(value)
  if type(issecretvalue) ~= "function" then return false end
  local ok, secret = pcall(issecretvalue, value)
  return not ok or secret == true
end

local function IsID(value)
  return not IsSecret(value) and type(value) == "number" and value >= 1 and value <= 2147483647 and value % 1 == 0
end

local function Find(specID, key)
  if IsSecret(specID) or IsSecret(key) then return nil end
  for _, definition in ipairs(definitions) do
    if definition.key == key then
      for _, candidate in ipairs(definition.specs) do
        if candidate == specID then return definition end
      end
    end
  end
end

local function FindChoice(definition, key)
  if IsSecret(key) then return nil end
  for _, choice in ipairs(definition.choices) do
    if choice.key == key then return choice end
  end
end

function Preferences.List(specID)
  local result = {}
  if not IsID(specID) then return result end
  for _, definition in ipairs(definitions) do
    if Find(specID, definition.key) then result[#result + 1] = definition end
  end
  return result
end

local function SavedSpec(specID, create)
  if not IsID(specID) then return nil, "Current specialization is unavailable." end
  if type(UnitGUID) ~= "function" then return nil, "Character identity is unavailable; preferences were not changed." end
  local ok, guid = pcall(UnitGUID, "player")
  if not ok or IsSecret(guid) or type(guid) ~= "string" or guid == "" then
    return nil, "Character identity is unavailable; preferences were not changed."
  end
  local dbName = ns.Identity and ns.Identity.dbGlobal
  if type(dbName) ~= "string" then return nil, "Saved preferences are unavailable." end
  local db = _G[dbName]
  if type(db) ~= "table" then
    if not create then return nil end
    db = {}; _G[dbName] = db
  end
  local saved = db.talentPreferences
  if saved ~= nil and (type(saved) ~= "table" or saved.version ~= 1) then
    return nil, "Saved preferences use an unsupported format; existing settings were kept."
  end
  if not saved then
    if not create then return nil end
    saved = { version = 1, characters = {} }; db.talentPreferences = saved
  end
  if type(saved.characters) ~= "table" then return nil, "Saved preferences are unavailable; existing settings were kept." end
  local character = saved.characters[guid]
  if character ~= nil and type(character) ~= "table" then return nil, "Saved character preferences are unavailable." end
  if not character then
    if not create then return nil end
    character = {}; saved.characters[guid] = character
  end
  local spec = character[specID]
  if spec ~= nil and type(spec) ~= "table" then return nil, "Saved specialization preferences are unavailable." end
  if not spec and create then spec = {}; character[specID] = spec end
  return spec
end

function Preferences.Get(specID, key)
  local definition = Find(specID, key)
  if not definition then return "recommended" end
  local saved = SavedSpec(specID, false)
  local choice = saved and saved[key]
  return FindChoice(definition, choice) and choice or "recommended"
end

function Preferences.Set(specID, key, choiceKey)
  local definition = Find(specID, key)
  if not definition or not FindChoice(definition, choiceKey) then return nil, "Unknown talent preference." end
  local saved, err = SavedSpec(specID, true)
  if not saved then return nil, err end
  saved[key] = choiceKey ~= "recommended" and choiceKey or nil
  return true
end

function Preferences.Reset(specID)
  local saved, err = SavedSpec(specID, false)
  if err then return nil, err end
  if saved then
    for _, definition in ipairs(Preferences.List(specID)) do saved[definition.key] = nil end
  end
  return true
end

local function ReadAPI(name, ...)
  if type(C_Traits) ~= "table" or type(C_Traits[name]) ~= "function" then return nil end
  local ok, value = pcall(C_Traits[name], ...)
  if not ok or IsSecret(value) or type(value) ~= "table" then return nil end
  return value
end

local function LivePairMatches(definition, configID)
  -- Wrap field access as well as API calls: neither exceptions nor secret values
  -- may be compared, saved, or shown to the player.
  local ok, matches = pcall(function()
    local node = ReadAPI("GetNodeInfo", configID, definition.nodeID)
    local selectionType = Enum and Enum.TraitNodeType and Enum.TraitNodeType.Selection
    if not node or IsSecret(node.ID) or node.ID ~= definition.nodeID or IsSecret(node.type)
      or not IsID(selectionType) or node.type ~= selectionType or IsSecret(node.maxRanks) or node.maxRanks ~= 1
      or IsSecret(node.subTreeID) or (node.subTreeID ~= nil and node.subTreeID ~= 0)
      or IsSecret(node.entryIDs) or type(node.entryIDs) ~= "table" or #node.entryIDs ~= 2 then return false end
    local expected = { [definition.choices[2].entryID] = definition.choices[2],
      [definition.choices[3].entryID] = definition.choices[3] }
    local seen, count = {}, 0
    for index, entryID in pairs(node.entryIDs) do
      if not IsID(index) or index > 2 or not IsID(entryID) or not expected[entryID] or seen[entryID] then return false end
      local entry = ReadAPI("GetEntryInfo", configID, entryID)
      if not entry or IsSecret(entry.maxRanks) or entry.maxRanks ~= 1 or not IsID(entry.definitionID)
        or IsSecret(entry.subTreeID) or (entry.subTreeID ~= nil and entry.subTreeID ~= 0) then return false end
      local info = ReadAPI("GetDefinitionInfo", entry.definitionID)
      if not info or not IsID(info.spellID) or info.spellID ~= expected[entryID].spellID then return false end
      seen[entryID], count = true, count + 1
    end
    return count == 2
  end)
  return ok and matches == true
end

local function Item(definition, choice, reason)
  return { key = definition.key, label = definition.label, choice = choice and choice.key,
    choiceLabel = choice and choice.label, reason = reason }
end

function Preferences.Build(text, specID, configID)
  local status = { applied = {}, skipped = {}, configuredCount = 0, changedCount = 0 }
  local saved, savedError = SavedSpec(specID, false)
  if savedError then
    status.skipped[1] = { key = "settings", label = "Preferences", reason = savedError }
    return text, status
  end
  if not saved then return text, status end
  local configured = {}
  for _, definition in ipairs(Preferences.List(specID)) do
    local value = saved[definition.key]
    if value ~= nil and not IsSecret(value) and value ~= "recommended" then
      status.configuredCount = status.configuredCount + 1
      local choice = FindChoice(definition, value)
      if choice then configured[#configured + 1] = { definition = definition, choice = choice }
      else status.skipped[#status.skipped + 1] = Item(definition, nil, "Saved choice is no longer supported; the setting was kept.") end
    end
  end
  for key, value in pairs(saved) do
    if type(key) == "string" and not IsSecret(key) and not Find(specID, key) and not IsSecret(value)
      and value ~= nil and value ~= "recommended" then
      status.configuredCount = status.configuredCount + 1
      status.skipped[#status.skipped + 1] = { key = "unsupported", label = "Saved preference",
        reason = "This preference is no longer supported; the setting was kept." }
    end
  end
  if #configured == 0 then return text, status end
  if not ns.TalentCodec or type(ns.TalentCodec.Decode) ~= "function" or type(ns.TalentCodec.ApplyChoices) ~= "function" then
    status.error = "Talent preferences cannot be checked right now."
    return nil, status
  end
  local ok, entries = pcall(ns.TalentCodec.Decode, text, specID, configID)
  if not ok or type(entries) ~= "table" then
    status.error = "The recommended talents could not be read safely; preferences were not applied."
    return nil, status
  end
  local selected = {}
  for _, entry in ipairs(entries) do selected[entry.nodeID] = entry end
  local overrides, accepted = {}, {}
  for _, pending in ipairs(configured) do
    local definition, choice = pending.definition, pending.choice
    local entry = selected[definition.nodeID]
    local reason
    if not entry or entry.ranksPurchased == 0 then
      reason = "Not selected in this recommended build."
    elseif entry.ranksPurchased ~= 1 or entry.ranksGranted ~= 0 or not LivePairMatches(definition, configID) then
      reason = "This talent changed or could not be checked in the current game version."
    elseif entry.selectionEntryID ~= definition.choices[2].entryID and entry.selectionEntryID ~= definition.choices[3].entryID then
      reason = "The recommended choice is no longer supported."
    end
    if reason then status.skipped[#status.skipped + 1] = Item(definition, choice, reason)
    else
      overrides[definition.nodeID] = choice.entryID
      accepted[#accepted + 1] = Item(definition, choice)
    end
  end
  if #accepted == 0 then return text, status end
  local rewritten, codecError, metadata
  ok, rewritten, codecError, metadata = pcall(ns.TalentCodec.ApplyChoices, text, specID, configID, overrides)
  if not ok or IsSecret(rewritten) or type(rewritten) ~= "string" or rewritten == "" then
    status.error = "The preferred talents could not be verified; no personalized build was produced."
    return nil, status
  end
  status.applied = accepted
  status.changedCount = type(metadata) == "table" and metadata.changedCount or 0
  return rewritten, status
end

function Preferences.Describe(status)
  if not status then return "Use recommended talents." end
  if status.error then return status.error end
  local applied, skipped = #(status.applied or {}), #(status.skipped or {})
  local message = applied == 1 and "1 preference applied." or applied > 1 and (applied .. " preferences applied.") or "Use recommended talents."
  if skipped > 0 then message = message .. " " .. skipped .. (skipped == 1 and " preference skipped." or " preferences skipped.") end
  return message
end

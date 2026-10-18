local _, ns = ...

-- Independent implementation of Blizzard's documented version-2 wire format.
-- This module only reads public trait APIs; it never opens or edits talent UI.
local Codec = {}
ns.TalentCodec = Codec

local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local alphabetValues = {}
for index = 1, #alphabet do
  alphabetValues[string.sub(alphabet, index, index)] = index - 1
end

local codecErrorTag = {}

local function Fail(message)
  error({ codecErrorTag, message }, 0)
end

local function IsSecret(value)
  if type(issecretvalue) ~= "function" then return false end
  local ok, secret = pcall(issecretvalue, value)
  return not ok or secret == true
end

-- Only our own fixed messages can leave the decoder. API exceptions can contain
-- arbitrary values (including secret values); never stringify or log them.
local function SafeError(value)
  local ok, message = pcall(function()
    if type(value) ~= "table" or rawget(value, 1) ~= codecErrorTag then return nil end
    local text = rawget(value, 2)
    if IsSecret(text) or type(text) ~= "string" then return nil end
    return string.sub(text, 1, 160)
  end)
  return ok and message or "Talent data could not be read safely."
end

local function IsInteger(value, minimum, maximum)
  return not IsSecret(value) and type(value) == "number"
    and value == value and value >= minimum and value <= maximum and value % 1 == 0
end

local function ReadAPI(owner, name, ...)
  if type(owner) ~= "table" or type(owner[name]) ~= "function" then
    Fail("Talent API unavailable: " .. name .. ".")
  end
  return owner[name](...)
end

local function ReadIDs(values, label, maximum)
  if type(values) ~= "table" then Fail(label .. " is unavailable.") end
  local count = #values
  if count == 0 or count > (maximum or 8192) then Fail(label .. " is invalid.") end
  local ids, seen, actualCount = {}, {}, 0
  for index, value in pairs(values) do
    if not IsInteger(index, 1, count) or not IsInteger(value, 1, 2147483647) or seen[value] then
      Fail(label .. " is invalid.")
    end
    ids[index], seen[value] = value, true
    actualCount = actualCount + 1
  end
  if actualCount ~= count then Fail(label .. " is incomplete.") end
  return ids
end

local function NewReader(text)
  if IsSecret(text) or type(text) ~= "string" or #text == 0 or #text > 16384 or text:find("[^A-Za-z0-9+/]") then
    Fail("Talent string must contain only Blizzard base64 characters.")
  end
  local offset, total = 0, #text * 6
  local function Read(width)
    if offset + width > total then Fail("Talent string is truncated.") end
    local result = 0
    for bit = 0, width - 1 do
      local position = offset + bit
      local character = string.sub(text, math.floor(position / 6) + 1, math.floor(position / 6) + 1)
      local value = alphabetValues[character]
      result = result + (math.floor(value / 2 ^ (position % 6)) % 2) * 2 ^ bit
    end
    offset = offset + width
    return result
  end
  local function Finish()
    if total - offset >= 6 then Fail("Talent string contains trailing characters.") end
    while offset < total do
      if Read(1) ~= 0 then Fail("Talent string contains nonzero padding.") end
    end
  end
  return Read, Finish
end

local function GetTree(specID, configID)
  local treeID = ReadAPI(C_ClassTalents, "GetTraitTreeForSpec", specID)
  if not IsInteger(treeID, 1, 2147483647) then Fail("Specialization talent tree is unavailable.") end
  local config = ReadAPI(C_Traits, "GetConfigInfo", configID)
  local trees = ReadIDs(type(config) == "table" and config.treeIDs, "Configuration trees")
  for _, candidate in ipairs(trees) do
    if candidate == treeID then return treeID end
  end
  Fail("Configuration belongs to a different talent tree.")
end

local function CheckHash(hash, treeID)
  local empty = true
  for _, byte in ipairs(hash) do
    if byte ~= 0 then empty = false end
  end
  if empty then return end -- Blizzard explicitly permits third-party zero hashes.
  local current = ReadAPI(C_Traits, "GetTreeHash", treeID)
  if type(current) ~= "table" or #current ~= 16 then Fail("Talent tree hash is unavailable.") end
  for index = 1, 16 do
    if not IsInteger(current[index], 0, 255) or current[index] ~= hash[index] then
      Fail("Talent string belongs to an outdated talent tree.")
    end
  end
end

local function Decode(text, expectedSpecID, configID)
  if not IsInteger(expectedSpecID, 1, 65535) or not IsInteger(configID, 1, 2147483647) then
    Fail("Current specialization or configuration is unavailable.")
  end
  local read, finish = NewReader(text)
  local version, specID = read(8), read(16)
  if version ~= 2 or ReadAPI(C_Traits, "GetLoadoutSerializationVersion") ~= 2 then
    Fail("Talent serialization version is unsupported.")
  end
  if specID ~= expectedSpecID then Fail("Talent string is for a different specialization.") end
  local hash = {}
  for index = 1, 16 do hash[index] = read(8) end
  local treeID = GetTree(specID, configID)
  CheckHash(hash, treeID)
  local nodeIDs = ReadIDs(ReadAPI(C_Traits, "GetTreeNodes", treeID), "Talent tree nodes")
  local types = Enum and Enum.TraitNodeType
  if not types or not IsInteger(types.Single, 0, 255) or not IsInteger(types.Selection, 0, 255)
    or not IsInteger(types.SubTreeSelection, 0, 255) or not IsInteger(types.Tiered, 0, 255) then
    Fail("Talent node types are unavailable.")
  end
  local entries = {}
  for _, nodeID in ipairs(nodeIDs) do
    if read(1) == 1 then
      local purchased = read(1) == 1
      local node = ReadAPI(C_Traits, "GetNodeInfo", configID, nodeID)
      if type(node) ~= "table" or node.ID ~= nodeID or not IsInteger(node.maxRanks, 1, 63) then
        Fail("Selected talent node is unavailable or invalid.")
      end
      local choice = node.type == types.Selection or node.type == types.SubTreeSelection
      local tiered = node.type == types.Tiered
      if not choice and not tiered and node.type ~= types.Single then Fail("Talent node type is unsupported.") end
      local entryIDs = ReadIDs(node.entryIDs, "Talent node entries", 64)
      local ranks, selection = 0, nil
      if purchased then
        local partial = read(1) == 1
        ranks = partial and read(6) or node.maxRanks
        if ranks < 1 or (partial and ranks >= node.maxRanks) then Fail("Talent partial rank is invalid.") end
        local encodedChoice = read(1) == 1
        if encodedChoice ~= choice then Fail("Talent choice flag does not match the current tree.") end
        if encodedChoice then
          selection = entryIDs[read(2) + 1]
          if not selection then Fail("Talent choice index is invalid.") end
        end
      end
      if tiered then
        local remaining = ranks
        for index, entryID in ipairs(entryIDs) do
          local info = ReadAPI(C_Traits, "GetEntryInfo", configID, entryID)
          if type(info) ~= "table" or not IsInteger(info.maxRanks, 1, 63) then Fail("Tiered talent entry is unavailable.") end
          local amount = math.min(remaining, info.maxRanks)
          local granted = not purchased and index == 1 and 1 or 0
          if amount > 0 or granted > 0 then
            entries[#entries + 1] = { nodeID = nodeID, ranksGranted = granted,
              ranksPurchased = amount, selectionEntryID = entryID }
          end
          remaining = remaining - amount
        end
        if remaining ~= 0 then Fail("Tiered talent ranks exceed entry capacity.") end
      else
        if not selection then
          selection = node.activeEntry and node.activeEntry.entryID or entryIDs[1]
        end
        local known = false
        for _, entryID in ipairs(entryIDs) do if entryID == selection then known = true end end
        if not known then Fail("Selected talent entry does not belong to its node.") end
        local info = ReadAPI(C_Traits, "GetEntryInfo", configID, selection)
        if type(info) ~= "table" or not IsInteger(info.maxRanks, 1, 63) or ranks > info.maxRanks then
          Fail("Talent entry ranks are unavailable or invalid.")
        end
        if node.type == types.SubTreeSelection and not IsInteger(info.subTreeID, 1, 2147483647) then
          Fail("Hero talent subtree is unavailable.")
        end
        entries[#entries + 1] = { nodeID = nodeID, ranksGranted = purchased and 0 or 1,
          ranksPurchased = ranks, selectionEntryID = selection }
      end
    end
  end
  finish()
  if #entries == 0 then Fail("Talent string contains no selected talents.") end
  return entries, nil, { treeID = treeID, specID = specID }
end

function Codec.Decode(text, specID, configID)
  local ok, entries, decodeError, metadata = pcall(Decode, text, specID, configID)
  if not ok then return nil, SafeError(entries) end
  return entries, decodeError, metadata
end

local function IsAutomaticGrant(entry, configID)
  if entry.ranksPurchased ~= 0 or entry.ranksGranted ~= 1 then return false end
  local node = ReadAPI(C_Traits, "GetNodeInfo", configID, entry.nodeID)
  if type(node) ~= "table" or node.ID ~= entry.nodeID or not Enum or not Enum.TraitNodeType
    or not IsInteger(node.type, 0, 255) or not IsInteger(Enum.TraitNodeType.Single, 0, 255) then
    Fail("Automatic talent grant metadata is unavailable.")
  end
  local entryIDs = ReadIDs(node.entryIDs, "Automatic talent grant entries", 64)
  return node.type == Enum.TraitNodeType.Single and #entryIDs == 1 and entryIDs[1] == entry.selectionEntryID
end

local function CanonicalEntries(entries, configID)
  if type(entries) ~= "table" or #entries == 0 then Fail("Expected talent entries are unavailable.") end
  local result, seen, purchasedCount = {}, {}, 0
  for _, entry in ipairs(entries) do
    if type(entry) ~= "table" or not IsInteger(entry.nodeID, 1, 2147483647)
      or not IsInteger(entry.selectionEntryID, 1, 2147483647)
      or not IsInteger(entry.ranksPurchased, 0, 63) or not IsInteger(entry.ranksGranted, 0, 1) then
      Fail("Expected talent entries are invalid.")
    end
    local key = entry.nodeID .. ":" .. entry.selectionEntryID
    if seen[key] then Fail("Expected talent entries contain a duplicate.") end
    seen[key] = entry
    if entry.ranksPurchased > 0 then purchasedCount = purchasedCount + 1 end
    -- Saved exports can omit automatic single-entry grants. Keep Decode's native
    -- entries intact; normalize only confirmed unambiguous grants here. Purchased
    -- ranks, choices, hero selectors and tiered entries still compare exactly.
    if not IsAutomaticGrant(entry, configID) then
      result[#result + 1] = key .. ":" .. entry.ranksPurchased .. ":" .. entry.ranksGranted
    end
  end
  if purchasedCount == 0 then Fail("Talent build contains no purchased entries.") end
  table.sort(result)
  return table.concat(result, ";")
end

-- Verify the whole exported configuration, including absence of extra purchases.
-- Callers must separately confirm population, selected ID, and completed apply.
function Codec.Verify(configID, entries, metadata)
  local ok, matches, reason = pcall(function()
    if type(metadata) ~= "table" or not IsInteger(metadata.specID, 1, 65535)
      or not IsInteger(metadata.treeID, 1, 2147483647) then Fail("Expected talent metadata is unavailable.") end
    local expectedSignature = CanonicalEntries(entries, configID)
    local text = ReadAPI(C_Traits, "GenerateImportString", configID)
    if IsSecret(text) or type(text) ~= "string" or #text == 0 then Fail("The saved talent export is unavailable.") end
    local actual, _, actualMetadata = Decode(text, metadata.specID, configID)
    local actualSignature = CanonicalEntries(actual, configID)
    if actualMetadata.treeID ~= metadata.treeID then
      return false, "The saved talent configuration belongs to a different tree."
    end
    if actualSignature ~= expectedSignature then
      return false, "The saved talent configuration does not match the requested build."
    end
    return true
  end)
  if not ok then
    local safeReason = SafeError(matches)
    return false, safeReason
  end
  return matches, reason
end

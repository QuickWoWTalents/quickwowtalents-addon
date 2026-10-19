local ADDON_NAME, NS = ...
NS = NS or {}
local Identity = {
  addonName = ADDON_NAME,
  title = "Quick WoW Talents",
  slash = "/qwt",
  dataGlobal = "QuickWoWTalentsData",
  dbGlobal = "QuickWoWTalentsDB",
  loadoutPrefix = "QWT-",
  legacyLoadoutName = "QWT",
  managedLoadoutPrefixes = { "QWT-", "QWTTest-" },
  autoOpenDefault = true
}
NS.Identity = Identity
local PREFIX = "|cff00c8ff" .. Identity.title .. "|r"
local DB
local function GetData()
  return _G[Identity.dataGlobal]
end
local function GetSavedState()
  local saved = _G[Identity.dbGlobal]
  if type(saved) ~= "table" then
    saved = {}
    _G[Identity.dbGlobal] = saved
  end
  return saved
end
local UI = { state = { mode = "mplus", encounterIds = {} } }
local CloseSelectorMenu
local WINDOW_WIDTH, WINDOW_HEIGHT, COPY_HEIGHT = 520, 410, 46
local COLORS = {
  background = { 0.067, 0.075, 0.082, 1 }, header = { 0.051, 0.059, 0.067, 1 },
  surface = { 0.098, 0.110, 0.122, 1 }, raised = { 0.141, 0.161, 0.180, 1 },
  border = { 0.255, 0.282, 0.310, 1 }, rule = { 0.188, 0.212, 0.239, 1 },
  text = { 0.929, 0.941, 0.953, 1 }, muted = { 0.651, 0.686, 0.725, 1 }
}
local WHITE_TEXTURE = "Interface\\Buttons\\WHITE8X8"
local skin
local ApplyOptionalSkin

local function FlatPanel(frame, fill, border)
  frame:SetBackdrop({ bgFile = WHITE_TEXTURE, edgeFile = WHITE_TEXTURE, edgeSize = 1 })
  frame:SetBackdropColor(unpack(fill or COLORS.surface))
  frame:SetBackdropBorderColor(unpack(border or COLORS.rule))
end

local function Label(parent, name, size, color)
  local label = parent:CreateFontString(name, "OVERLAY", "GameFontHighlight")
  label:SetFont("Fonts\\ARIALN.TTF", size, "")
  label:SetShadowOffset(0, 0)
  label:SetTextColor(unpack(color or COLORS.text))
  label:SetJustifyH("LEFT")
  label:SetJustifyV("TOP")
  UI.fonts = UI.fonts or {}
  UI.fonts[#UI.fonts + 1] = label
  return label
end

local function Solid(parent, color)
  local texture = parent:CreateTexture(nil, "ARTWORK")
  texture:SetColorTexture(unpack(color))
  return texture
end

local function ActionButton(parent, name, text, primary)
  local button = CreateFrame("Button", name, parent, "BackdropTemplate")
  local label = Label(button, nil, 15)
  label:SetPoint("CENTER")
  label:SetJustifyH("CENTER")
  label:SetJustifyV("MIDDLE")
  button:SetFontString(label)
  button:SetText(text)
  button.Text = label
  local function Paint()
    local enabled = button:IsEnabled()
    local color = primary and UI.classColor or COLORS.raised
    color = color or { 0.20, 0.65, 0.90 }
    local r, g, b = color[1], color[2], color[3]
    if button.hovered and enabled then r, g, b = math.min(1, r + .08), math.min(1, g + .08), math.min(1, b + .08) end
    if not enabled then r, g, b = .12, .14, .16 end
    FlatPanel(button, { r, g, b, 1 }, primary and { r, g, b, 1 } or COLORS.border)
    if not enabled then label:SetTextColor(.5, .54, .58)
    elseif primary and (.2126 * r + .7152 * g + .0722 * b) > .52 then label:SetTextColor(.035, .045, .055)
    else label:SetTextColor(unpack(COLORS.text)) end
  end
  button:SetScript("OnEnter", function() button.hovered = true; Paint() end)
  button:SetScript("OnLeave", function() button.hovered = false; Paint() end)
  button:SetScript("OnEnable", Paint)
  button:SetScript("OnDisable", Paint)
  button.RefreshStyle = Paint
  Paint()
  return button
end

local function SetCopyPanelShown(shown)
  if not UI.copyPanel then return end
  if shown then UI.copyPanel:Show() else UI.copyPanel:Hide() end
  UI.frame:SetHeight(WINDOW_HEIGHT + (shown and COPY_HEIGHT or 0))
end

local function RefreshClassStyle(specID, specName, recommendation)
  local clientClassName, classToken
  if UnitClass then clientClassName, classToken = UnitClass("player") end
  local className = recommendation and recommendation.className
  local data = GetData()
  local specEntry = data and data.recommendations and data.recommendations[specID]
  className = className or (specEntry and specEntry.className) or clientClassName or ""
  local color = classToken and RAID_CLASS_COLORS and RAID_CLASS_COLORS[classToken]
  UI.classColor = color and { color.r, color.g, color.b } or { .20, .65, .90 }
  UI.specLine:SetText((specName or "Choose a specialization") .. (className ~= "" and (" " .. className) or ""))
  UI.specLine:SetTextColor(unpack(UI.classColor))
  local getIndex = C_SpecializationInfo and C_SpecializationInfo.GetSpecialization or GetSpecialization
  local getInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo or GetSpecializationInfo
  local index = getIndex and getIndex()
  local icon = index and getInfo and select(4, getInfo(index))
  UI.specIcon:SetTexture(icon or "Interface\\Icons\\INV_Misc_QuestionMark")
  UI.importButton:RefreshStyle()
end
local SetAutoOpenEnabled
local ScheduleAutoOpenCheck
local AUTO_OPEN_DELAY_SECONDS = 1.5
local DATA_UPDATE_REQUIRED_MESSAGE = "Update required: install the latest Quick WoW Talents."

-- Supported Mythic+ client IDs, cross-checked against current addon databases.
-- WoW exposes challenge map / instance map IDs in-game; QWT recommendation data uses
-- Warcraft Logs encounter IDs, so auto-open needs an explicit translation layer.
local MPLUS_DUNGEON_CONTEXTS = {
  { qwtDungeonId = 12993, challengeMapId = 588, instanceMapIds = { 2993 }, name = "Altar of Fangs" },
  { qwtDungeonId = 12825, challengeMapId = 586, instanceMapIds = { 2825 }, name = "Den of Nalorakk" },
  { qwtDungeonId = 61762, challengeMapId = 249, instanceMapIds = { 1762 }, name = "Kings' Rest" },
  { qwtDungeonId = 12813, challengeMapId = 587, instanceMapIds = { 2813 }, name = "Murder Row" },
  { qwtDungeonId = 112521, challengeMapId = 399, instanceMapIds = { 2521 }, name = "Ruby Life Pools" },
  { qwtDungeonId = 61877, challengeMapId = 250, instanceMapIds = { 1877 }, name = "Temple of Sethraliss" },
  { qwtDungeonId = 12859, challengeMapId = 584, instanceMapIds = { 2859 }, name = "The Blinding Vale" },
  { qwtDungeonId = 12923, challengeMapId = 585, instanceMapIds = { 2923 }, name = "Voidscar Arena" }
}

local MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID = {}
local MPLUS_DUNGEON_BY_INSTANCE_MAP_ID = {}

for _, context in ipairs(MPLUS_DUNGEON_CONTEXTS) do
  MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID[context.challengeMapId] = context
  for _, instanceMapId in ipairs(context.instanceMapIds) do
    MPLUS_DUNGEON_BY_INSTANCE_MAP_ID[instanceMapId] = context
  end
end

local function Print(message)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. ": " .. tostring(message))
end

local function GetDataCompatibilityError()
  local data = GetData()
  local clientInterface = select(4, GetBuildInfo())
  if type(data) ~= "table" or data.schemaVersion ~= 3 then
    return DATA_UPDATE_REQUIRED_MESSAGE
  end
  if data.clientInterface ~= clientInterface then
    return DATA_UPDATE_REQUIRED_MESSAGE
  end
  return nil
end

local function ReportDataCompatibilityError()
  local compatibilityError = GetDataCompatibilityError()
  if not compatibilityError then
    UI.reportedCompatibilityError = nil
    return false
  end
  if UI.reportedCompatibilityError ~= compatibilityError then
    UI.reportedCompatibilityError = compatibilityError
    Print(compatibilityError)
  end
  return true
end

local function IsInCombat()
  return InCombatLockdown and InCombatLockdown()
end

local function IsImportBusy()
  return NS.TalentImport and NS.TalentImport.IsBusy()
end

local function GetLoadoutName(encounter)
  -- Keep names readable without allowing embedded chat colours, links or controls.
  local label = tostring(encounter.name or "Build")
  label = label:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
  label = label:gsub("|H.-|h(.-)|h", "%1"):gsub("|[TA].-|[ta]", "")
  label = strtrim(label:gsub("[%c|]", " "):gsub("%s+", " "))
  if label == "" then label = "Build" end
  -- Truncate complete UTF-8 characters, including the prefix, to 31 characters.
  local name, count = Identity.loadoutPrefix, #Identity.loadoutPrefix
  for character in label:gmatch("[%z\1-\127\194-\244][\128-\191]*") do
    if count >= 31 then break end
    name, count = name .. character, count + 1
  end
  return strtrim(name)
end

local function CountRecommendationTable(encounters)
  local count = 0
  if type(encounters) == "table" then
    for _, recommendation in pairs(encounters) do
      if type(recommendation) == "table" and recommendation.importString then
        count = count + 1
      end
    end
  end
  return count
end

local function CountRecommendations()
  if GetDataCompatibilityError() then
    return 0
  end
  local data = GetData() or {}
  local count = 0

  if type(data.recommendations) == "table" then
    for _, entry in pairs(data.recommendations) do
      if type(entry) == "table" then
        if type(entry.mplus) == "table" then
          count = count + CountRecommendationTable(entry.mplus.encounters)
        end
        if type(entry.raid) == "table" then
          count = count + CountRecommendationTable(entry.raid.encounters)
        end
      end
    end
  end

  return count
end

local function GetCurrentSpecInfo()
  local getSpecialization = C_SpecializationInfo and C_SpecializationInfo.GetSpecialization or GetSpecialization
  local getSpecializationInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo or GetSpecializationInfo

  if not getSpecialization or not getSpecializationInfo then
    return nil, nil, "Specialization API is not available."
  end

  local specIndex = getSpecialization()
  if not specIndex then
    return nil, nil, "Choose a specialization first, then run " .. Identity.slash .. " again."
  end

  local specID, specName = getSpecializationInfo(specIndex)
  if not specID then
    return nil, nil, "Could not detect current specialization."
  end

  return specID, specName, nil
end

local function GetModeConfig(mode)
  if GetDataCompatibilityError() then
    return nil
  end
  local data = GetData() or {}
  if data.modes and data.modes[mode] then
    return data.modes[mode]
  end
  return nil
end

local function GetModeLabel(mode)
  if mode == "raid" then
    return "Raid"
  end
  return "Mythic+"
end

local function GetMplusRecommendationLabel()
  local config = GetModeConfig("mplus")
  if config and config.recommendationLabel then
    return tostring(config.recommendationLabel)
  end
  if config and config.minimumKeystoneLevel then
    return "Best Overall (" .. tostring(config.minimumKeystoneLevel) .. "+)"
  end
  return "Best Overall"
end

local function GetEncounterList(mode)
  local config = GetModeConfig(mode)
  if not config then
    return {}
  end
  if mode == "raid" then
    return config.bosses or {}
  end
  return config.dungeons or {}
end

local function FindEncounter(mode, encounterId)
  local id = tonumber(encounterId)
  for _, encounter in ipairs(GetEncounterList(mode)) do
    if tonumber(encounter.id) == id then
      return encounter
    end
  end
  return nil
end

local function GetFirstEncounterId(mode)
  local encounters = GetEncounterList(mode)
  if encounters[1] then
    return tonumber(encounters[1].id)
  end
  return nil
end

local function NormalizeMode(mode)
  if mode == "raid" and GetModeConfig("raid") then
    return "raid"
  end
  return "mplus"
end

local function EnsureState()
  DB = GetSavedState()
  DB.encounterIds = DB.encounterIds or {}
  if DB.autoOpenEnabled == nil then
    DB.autoOpenEnabled = Identity.autoOpenDefault
  end

  UI.state.mode = NormalizeMode(DB.mode or UI.state.mode or "mplus")
  UI.state.encounterIds = UI.state.encounterIds or {}

  for _, mode in ipairs({ "mplus", "raid" }) do
    local savedId = tonumber(DB.encounterIds[mode])
    local currentId = tonumber(UI.state.encounterIds[mode]) or savedId
    if currentId and FindEncounter(mode, currentId) then
      UI.state.encounterIds[mode] = currentId
    else
      UI.state.encounterIds[mode] = GetFirstEncounterId(mode)
    end
  end
end

local function SaveState()
  DB = GetSavedState()
  DB.encounterIds = DB.encounterIds or {}
  DB.mode = UI.state.mode
  DB.encounterIds.mplus = UI.state.encounterIds.mplus
  DB.encounterIds.raid = UI.state.encounterIds.raid
end

local function GetSelectedEncounterId()
  EnsureState()
  return UI.state.encounterIds[UI.state.mode]
end

local function GetSelectedEncounter()
  return FindEncounter(UI.state.mode, GetSelectedEncounterId())
end

local function GetRecommendation()
  local compatibilityError = GetDataCompatibilityError()
  if compatibilityError then
    return nil, compatibilityError
  end
  EnsureState()

  local data = GetData() or {}
  local specID, specName, errorMessage = GetCurrentSpecInfo()
  if errorMessage then
    return nil, errorMessage
  end

  local specEntry = data.recommendations and data.recommendations[specID]
  if not specEntry then
    return nil, "No bundled recommendations for " .. tostring(specName) .. " (spec ID " .. tostring(specID) .. "). Data has " .. CountRecommendations() .. " total strings."
  end

  local selectedEncounterId = GetSelectedEncounterId()
  local recommendation = nil

  if UI.state.mode == "raid" then
    recommendation = specEntry.raid and specEntry.raid.encounters and specEntry.raid.encounters[selectedEncounterId]
  else
    recommendation = specEntry.mplus and specEntry.mplus.encounters and specEntry.mplus.encounters[selectedEncounterId]
  end

  if not recommendation or not recommendation.importString then
    local encounter = GetSelectedEncounter()
    local encounterName = encounter and encounter.name or tostring(selectedEncounterId or "unknown encounter")
    return nil, "No bundled " .. GetModeLabel(UI.state.mode) .. " recommendation for " .. tostring(specName) .. " / " .. encounterName .. "."
  end

  return recommendation, nil
end

local function DisarmCloseAfterCopy()
  UI.closeOnNextCopy = false
  UI.copyModifierDown = false
  UI.copyCloseToken = (UI.copyCloseToken or 0) + 1
end

local function ShowImportTextFromStart()
  DisarmCloseAfterCopy()
  SetCopyPanelShown(false)
  if UI.importBox then
    UI.importBox:HighlightText(0, 0)
    UI.importBox:SetCursorPosition(0)
    UI.importBox:ClearFocus()
  end
end

local function IsCopyModifierKey(key)
  return key == "LCTRL" or key == "RCTRL" or key == "LMETA" or key == "RMETA"
end

local function CloseAfterNativeCopy()
  local token = (UI.copyCloseToken or 0) + 1
  UI.copyCloseToken = token

  -- Defer the hide very briefly so the native WoW/OS copy shortcut can complete first.
  C_Timer.After(0.1, function()
    if UI.closeOnNextCopy and UI.copyCloseToken == token and UI.frame and UI.frame:IsShown() then
      UI.frame:Hide()
    end
    DisarmCloseAfterCopy()
  end)
end

local function SelectImportText(closeOnNextCopy)
  local compatibilityError = GetDataCompatibilityError()
  if compatibilityError then
    ReportDataCompatibilityError()
    DisarmCloseAfterCopy()
    if UI.importBox then
      UI.importBox:SetText("")
      UI.importBox:ClearFocus()
    end
    if UI.hint then
      UI.hint:SetText(compatibilityError)
    end
    return
  end

  if UI.importBox then
    local text = UI.importBox:GetText() or ""
    SetCopyPanelShown(true)
    UI.importBox:SetFocus()
    UI.importBox:SetCursorPosition(0)
    UI.importBox:HighlightText(0, string.len(text))
  end

  if closeOnNextCopy then
    UI.closeOnNextCopy = true
    UI.copyModifierDown = false
    if UI.hint then
      UI.hint:SetText("Import string selected — press Ctrl+C now")
      UI.hint:SetTextColor(0.2, 1, 0.2)
    end
  elseif UI.hint then
    UI.hint:SetText("Import string selected. Press Ctrl+C, then paste in Talents → Loadouts → Import.")
  end
end

local function SetDropdownText(dropdown, text)
  if dropdown then
    dropdown.dropdownText = text
    if dropdown.control then dropdown.control.Text:SetText(text) end
  end
end

local function UpdateDropdownLabels()
  EnsureState()
  SetDropdownText(UI.modeDropdown, GetModeLabel(UI.state.mode))

  local encounter = GetSelectedEncounter()
  if UI.state.mode == "raid" then
    SetDropdownText(UI.encounterDropdown, encounter and encounter.name or "Select boss")
  else
    SetDropdownText(UI.encounterDropdown, encounter and encounter.name or "Select dungeon")
  end

  if UI.encounterLabel then
    UI.encounterLabel:SetText(UI.state.mode == "raid" and "Boss" or "Dungeon")
  end
end

local function UpdateRecommendation(selectText)
  if CloseSelectorMenu then CloseSelectorMenu() end
  if IsImportBusy() then
    UI.pendingRecommendationRefresh = true
    return
  end
  UI.pendingRecommendationRefresh = nil
  local recommendation, errorMessage = GetRecommendation()
  local data = GetData() or {}
  local specID, specName = GetCurrentSpecInfo()
  local encounter = GetSelectedEncounter()
  UI.hasRecommendation = recommendation ~= nil and errorMessage == nil

  UpdateDropdownLabels()
  if UI.autoOpenCheckbox then UI.autoOpenCheckbox:SetChecked(DB.autoOpenEnabled ~= false) end

  if UI.specLine then RefreshClassStyle(specID, specName, recommendation) end

  if errorMessage then
    DisarmCloseAfterCopy()
    UI.subtitle:SetText(errorMessage)
    UI.meta:SetText("Try another encounter or check for an addon update.")
    UI.buildLabel:SetText("BUILD UNAVAILABLE")
    UI.importBox:SetText("")
    ShowImportTextFromStart()
    UI.hint:SetText(errorMessage)
    UI.hint:SetTextColor(1, 0.82, 0)
    UI.footer:SetText("Offline recommendations · " .. tostring(CountRecommendations()) .. " available builds")
    if UI.importButton then UI.importButton:Disable() end
    return
  end

  local snapshot = recommendation.snapshotDate or "unknown snapshot"
  local generated = data.generatedAt or recommendation.generatedAt or "unknown generation time"
  local sampleCount = recommendation.sampleCount or 0
  local encounterName = encounter and encounter.name or recommendation.dungeonName or recommendation.bossName or "selected encounter"
  local contextText = UI.state.mode == "raid"
    and "Raid"
    or ("Mythic+ " .. GetMplusRecommendationLabel())

  DisarmCloseAfterCopy()
  UI.buildLabel:SetText(string.upper(contextText))
  UI.subtitle:SetText(encounterName)
  UI.meta:SetText(tostring(sampleCount) .. " top logs  ·  " .. string.upper(tostring(recommendation.metric or "DPS")) .. "  ·  Shared action bars")
  UI.importBox:SetText(recommendation.importString or "")
  UI.hint:SetText("Add and apply this build, replacing any pending talent edits.")
  UI.hint:SetTextColor(unpack(COLORS.muted))
  UI.footer:SetText("Snapshot " .. tostring(snapshot) .. "  ·  Offline recommendations")
  UI.footerDetails = "Snapshot: " .. tostring(snapshot) .. "\nBundled: " .. tostring(generated)
  if UI.importButton then
    UI.importButton:SetEnabled(NS.TalentImport ~= nil and not NS.TalentImport.IsBusy())
  end

  if selectText then
    SelectImportText()
  else
    ShowImportTextFromStart()
  end
end

-- This is a read-only view of WoW's talent-commit cast. The importer remains the
-- only authority for application, verification, cleanup and completion.
local TALENT_COMMIT_SPELL = Constants and Constants.TraitConsts
  and Constants.TraitConsts.COMMIT_COMBAT_TRAIT_CONFIG_CHANGES_SPELL_ID or 384255
local PROGRESS_PHASES = {
  importing = "Preparing talents...", saved = "Preparing talents...",
  sharing = "Enabling shared action bars...", ready = "Waiting for talent application...",
  loading = "Waiting for talent application...", selecting = "Verifying talents...",
  cleanup = "Removing earlier QWT builds...", deleting = "Removing earlier QWT builds..."
}

local function PublicNumber(value)
  if issecretvalue and issecretvalue(value) then return false end
  return type(value) == "number" and value == value and value > -math.huge and value < math.huge
end

local function ReadTalentCast()
  if type(UnitCastingInfo) ~= "function" or type(GetTime) ~= "function" then return end
  local ok, cast = pcall(function()
    local _, _, _, startMS, endMS, _, castID, _, spellID = UnitCastingInfo("player")
    if not PublicNumber(spellID) or spellID ~= TALENT_COMMIT_SPELL
      or not PublicNumber(startMS) or not PublicNumber(endMS) or endMS <= startMS then return end
    local now = GetTime()
    if not PublicNumber(now) or now * 1000 < startMS or now * 1000 >= endMS then return end
    if (issecretvalue and issecretvalue(castID)) or type(castID) ~= "string" then castID = nil end
    return { startMS = startMS, endMS = endMS, now = now, castID = castID }
  end)
  if ok then return cast end
end

local function RefreshApplyProgress()
  local bar = UI.applyProgress
  if not bar then return end
  if not UI.importProgressActive or not IsImportBusy() then
    bar:Hide()
    bar.cast, bar.ignoredCast = nil, nil
    bar:SetValue(0)
    bar.Time:SetText("")
    return
  end
  local phase
  if NS.TalentImport and type(NS.TalentImport.GetStatus) == "function" then
    local ok, status = pcall(NS.TalentImport.GetStatus)
    if ok and type(status) == "table" then phase = status.phase end
  end
  bar:Show()
  local cast = ReadTalentCast()
  if phase == "selecting" or phase == "cleanup" or phase == "deleting" then cast = nil end
  if cast and bar.ignoredCast and cast.startMS == bar.ignoredCast.startMS and cast.endMS == bar.ignoredCast.endMS then cast = nil end
  bar.cast = cast
  if cast then
    local duration = (cast.endMS - cast.startMS) / 1000
    bar:SetMinMaxValues(0, duration)
    bar:SetValue(math.max(0, math.min(duration, cast.now - cast.startMS / 1000)))
    local color = UI.classColor or { .20, .65, .90 }
    -- Darken class fill to preserve contrast for the light progress label.
    bar:SetStatusBarColor(color[1] * .5, color[2] * .5, color[3] * .5, 1)
    bar.Label:SetText("Applying talents...")
    bar.Time:SetText(string.format("%.1fs", math.max(0, cast.endMS / 1000 - cast.now)))
  else
    bar:SetMinMaxValues(0, 1)
    bar:SetValue(0)
    bar.Label:SetText(PROGRESS_PHASES[phase] or "Preparing talents...")
    bar.Time:SetText("")
  end
end

local function SetApplyProgressActive(active)
  UI.importProgressActive = active
  if UI.applyProgress then UI.applyProgress.ignoredCast = nil end
  RefreshApplyProgress()
end

local function CreateApplyProgress(frame)
  local bar = CreateFrame("StatusBar", ADDON_NAME .. "ApplyProgress", frame, "BackdropTemplate")
  bar:SetPoint("TOPLEFT", 18, -290)
  bar:SetSize(484, 18)
  FlatPanel(bar, COLORS.header, COLORS.rule)
  bar:SetStatusBarTexture(WHITE_TEXTURE)
  bar:SetMinMaxValues(0, 1)
  bar:SetValue(0)
  bar.Label = Label(bar, ADDON_NAME .. "ProgressLabel", 11)
  bar.Label:SetPoint("LEFT", 7, 0)
  bar.Label:SetWidth(410)
  bar.Label:SetJustifyV("MIDDLE")
  bar.Time = Label(bar, ADDON_NAME .. "ProgressTime", 11)
  bar.Time:SetPoint("RIGHT", -7, 0)
  bar.Time:SetJustifyV("MIDDLE")
  bar.Time:SetJustifyH("RIGHT")
  bar:Hide()
  UI.applyProgress = bar
  bar:SetScript("OnUpdate", function(self, elapsed)
    self.elapsed = (self.elapsed or 0) + elapsed
    if self.elapsed < .05 then return end
    self.elapsed = 0
    RefreshApplyProgress()
  end)
  -- Events are filtered before reading cast details; no foreign cast data is
  -- stored, and restricted timings fall back to the ordinary import stage.
  for _, event in ipairs({ "UNIT_SPELLCAST_START", "UNIT_SPELLCAST_DELAYED", "UNIT_SPELLCAST_STOP",
    "UNIT_SPELLCAST_FAILED", "UNIT_SPELLCAST_INTERRUPTED", "UNIT_SPELLCAST_SUCCEEDED" }) do
    bar:RegisterUnitEvent(event, "player")
  end
  bar:SetScript("OnEvent", function(self, event, unit, castID, spellID)
    if issecretvalue and issecretvalue(unit) then return end
    if unit ~= "player" or not UI.importProgressActive then return end
    if not PublicNumber(spellID) or spellID ~= TALENT_COMMIT_SPELL then return end
    if event == "UNIT_SPELLCAST_START" or event == "UNIT_SPELLCAST_DELAYED" then
      self.ignoredCast = nil
    else
      if issecretvalue and issecretvalue(castID) then return end
      local cast = ReadTalentCast() or self.cast
      -- A late STOP from an earlier cast must not hide a newly started cast.
      if cast and cast.castID and cast.castID == castID then self.ignoredCast = cast end
    end
    RefreshApplyProgress()
  end)
end

local function ImportSelectedBuild()
  if CloseSelectorMenu then CloseSelectorMenu() end
  if IsImportBusy() then
    return
  end
  if IsInCombat() then
    Print("Can't import during combat. Try again when combat ends.")
    return
  end
  local recommendation, errorMessage = GetRecommendation()
  local encounter = GetSelectedEncounter()
  local specID = GetCurrentSpecInfo()
  if errorMessage or not encounter or not specID then
    Print(errorMessage or "Select an encounter and specialization first.")
    return
  end
  if not NS.TalentImport then
    Print("Talent importing is unavailable. Select the import string and paste it in Talents.")
    return
  end
  DisarmCloseAfterCopy()
  local requestedMode, requestedEncounterId = UI.state.mode, tonumber(encounter.id)
  SetApplyProgressActive(true)
  local accepted, importError = NS.TalentImport.Begin({
    importString = recommendation.importString,
    specID = specID,
    name = GetLoadoutName(encounter),
    onStatus = function(message, isDone, success)
      if isDone then SetApplyProgressActive(false) else RefreshApplyProgress() end
      if isDone and UI.pendingRecommendationRefresh then UpdateRecommendation(false) end
      local sameSelection = GetCurrentSpecInfo() == specID and UI.state.mode == requestedMode
        and UI.state.encounterIds[requestedMode] == requestedEncounterId
      if UI.hint and sameSelection then
        UI.hint:SetText(tostring(message))
        if isDone and success then UI.hint:SetTextColor(0.2, 1, 0.2)
        else UI.hint:SetTextColor(1, 0.82, 0) end
      end
      if UI.importButton then UI.importButton:SetEnabled(UI.hasRecommendation == true and not IsImportBusy()) end
      if isDone then
        Print(message)
        if UI.pendingAutoOpenReason then
          local reason = UI.pendingAutoOpenReason
          UI.pendingAutoOpenReason = nil
          ScheduleAutoOpenCheck(reason)
        end
      end
    end
  })
  if not accepted then
    SetApplyProgressActive(false)
    local message = importError or "Import couldn't start. You can copy the string instead."
    if UI.hint then UI.hint:SetText(message); UI.hint:SetTextColor(1, 0.82, 0) end
    Print(message)
  end
  RefreshApplyProgress()
  if UI.importButton then UI.importButton:SetEnabled(UI.hasRecommendation == true and not IsImportBusy()) end
end

local function SetMode(mode)
  if IsImportBusy() then return end
  UI.state.mode = NormalizeMode(mode)
  if not UI.state.encounterIds[UI.state.mode] then
    UI.state.encounterIds[UI.state.mode] = GetFirstEncounterId(UI.state.mode)
  end
  SaveState()
  UpdateRecommendation(false)
end

local function SetEncounter(mode, encounterId)
  if IsImportBusy() then return end
  UI.state.mode = NormalizeMode(mode)
  UI.state.encounterIds[UI.state.mode] = tonumber(encounterId)
  SaveState()
  UpdateRecommendation(false)
end

local function InitializeModeDropdown(dropdown)
  dropdown.getOptions = function()
    local options = {}
    for _, option in ipairs({
      { id = "mplus", text = "Mythic+" },
      { id = "raid", text = GetModeLabel("raid") }
    }) do
      if GetModeConfig(option.id) then
        local mode = option.id
        local info = {}
        info.text = option.text
        info.checked = UI.state.mode == mode
        info.func = function()
          SetMode(mode)
        end
        options[#options + 1] = info
      end
    end
    return options
  end
end

local function InitializeEncounterDropdown(dropdown)
  dropdown.getOptions = function()
    local options = {}
    local mode = UI.state.mode
    local selectedEncounterId = GetSelectedEncounterId()
    for _, encounter in ipairs(GetEncounterList(mode)) do
      local encounterId = tonumber(encounter.id)
      local info = {}
      info.text = encounter.name
      info.checked = selectedEncounterId == encounterId
      info.func = function()
        SetEncounter(mode, encounterId)
      end
      options[#options + 1] = info
    end
    return options
  end
end

CloseSelectorMenu = function()
  if UI.openSelector then UI.openSelector:Hide() end
end

local function CreateSelector(parent, name, width, initialize)
  local control = CreateFrame("Button", name .. "Control", parent, "BackdropTemplate")
  control:SetSize(width, 36)
  FlatPanel(control, COLORS.raised, COLORS.border)
  control.Text = Label(control, nil, 14)
  control.Text:SetPoint("LEFT", 12, 0)
  control.Text:SetPoint("RIGHT", -36, 0)
  control.Text:SetJustifyV("MIDDLE")
  for index, angle in ipairs({ -math.pi / 4, math.pi / 4 }) do
    local line = Solid(control, COLORS.muted)
    line:SetSize(7, 1)
    line:SetPoint("RIGHT", index == 1 and -19 or -14, 0)
    line:SetRotation(angle)
  end
  -- Own the list as well as the trigger; shared Blizzard dropdown frames are
  -- never painted, hooked or reused by this menu.
  local dropdown = CreateFrame("Frame", name, parent, "BackdropTemplate")
  dropdown:SetFrameLevel(parent:GetFrameLevel() + 20)
  dropdown:SetClampedToScreen(true)
  dropdown:SetPoint("TOPLEFT", control, "BOTTOMLEFT", 0, -3)
  local menuWidth, rowHeight, maxRows = math.max(width, 192), 28, 8
  dropdown:SetWidth(menuWidth)
  FlatPanel(dropdown, COLORS.header, COLORS.border)
  dropdown:EnableMouse(true)
  dropdown:EnableMouseWheel(true)
  dropdown:EnableKeyboard(true)
  dropdown.rows, dropdown.options, dropdown.offset, dropdown.focused = {}, {}, 0, 1
  dropdown.control = control
  initialize(dropdown)
  local function Choose(index)
    if not dropdown:IsVisible() or IsImportBusy() or IsInCombat() then CloseSelectorMenu(); return end
    local option = dropdown.options[index]
    CloseSelectorMenu()
    if option then option.func() end
  end
  for index = 1, maxRows do
    local row = CreateFrame("Button", name .. "Row" .. index, dropdown, "BackdropTemplate")
    row:SetPoint("TOPLEFT", 4, -4 - (index - 1) * rowHeight)
    row:SetSize(menuWidth - 8, rowHeight)
    row.Text = Label(row, nil, 14)
    row.Text:SetPoint("LEFT", 18, 0)
    row.Text:SetPoint("RIGHT", -8, 0)
    row.Text:SetWordWrap(false)
    row.Text:SetJustifyV("MIDDLE")
    row.Selected = Solid(row, COLORS.text)
    row.Selected:SetPoint("LEFT", 6, 0)
    row.Selected:SetSize(3, 16)
    row:SetScript("OnClick", function() Choose(row.index) end)
    row:SetScript("OnEnter", function()
      dropdown.focused = row.index
      dropdown.Refresh()
    end)
    dropdown.rows[index] = row
  end
  local previous = ActionButton(dropdown, name .. "Previous", "<", false)
  previous:SetSize(24, 22)
  previous:SetPoint("BOTTOMLEFT", 4, 4)
  local nextButton = ActionButton(dropdown, name .. "Next", ">", false)
  nextButton:SetSize(24, 22)
  nextButton:SetPoint("BOTTOMRIGHT", -4, 4)
  local count = Label(dropdown, nil, 11, COLORS.muted)
  count:SetPoint("BOTTOM", 0, 8)
  count:SetJustifyH("CENTER")
  dropdown.Previous, dropdown.Next, dropdown.Count = previous, nextButton, count
  dropdown.Refresh = function()
    local total = #dropdown.options
    local visible = math.min(maxRows, total)
    dropdown.offset = math.max(0, math.min(dropdown.offset, total - visible))
    dropdown:SetHeight(8 + visible * rowHeight + (total > maxRows and 28 or 0))
    for index, row in ipairs(dropdown.rows) do
      local optionIndex = dropdown.offset + index
      local option = dropdown.options[optionIndex]
      if option then
        row.index = optionIndex
        row.Text:SetText(option.text)
        local color = option.checked and UI.classColor or COLORS.text
        row.Text:SetTextColor(unpack(color or COLORS.text))
        if option.checked then
          row.Selected:SetColorTexture(unpack(UI.classColor or COLORS.text))
          row.Selected:Show()
        else row.Selected:Hide() end
        local fill = optionIndex == dropdown.focused and COLORS.raised or COLORS.header
        FlatPanel(row, fill, fill)
        row:Show()
      else row:Hide() end
    end
    if total > maxRows then
      previous:Show(); nextButton:Show(); count:Show()
      previous:SetEnabled(dropdown.offset > 0)
      nextButton:SetEnabled(dropdown.offset + visible < total)
      count:SetText((dropdown.offset + 1) .. "–" .. (dropdown.offset + visible) .. " / " .. total)
    else previous:Hide(); nextButton:Hide(); count:Hide() end
  end
  local function Scroll(delta)
    dropdown.offset = math.max(0, math.min(dropdown.offset + delta, math.max(0, #dropdown.options - maxRows)))
    dropdown.focused = math.max(dropdown.offset + 1, math.min(dropdown.focused, dropdown.offset + maxRows))
    dropdown.Refresh()
  end
  previous:SetScript("OnClick", function() Scroll(-maxRows) end)
  nextButton:SetScript("OnClick", function() Scroll(maxRows) end)
  dropdown:SetScript("OnMouseWheel", function(_, delta) Scroll(delta > 0 and -1 or 1) end)
  dropdown:SetScript("OnKeyDown", function(self, key)
    if IsInCombat() then CloseSelectorMenu(); return end
    local handled = key == "ESCAPE" or key == "UP" or key == "DOWN" or key == "HOME" or key == "END"
      or key == "PAGEUP" or key == "PAGEDOWN" or key == "ENTER" or key == "SPACE"
    self:SetPropagateKeyboardInput(not handled)
    if key == "ESCAPE" then CloseSelectorMenu()
    elseif key == "ENTER" or key == "SPACE" then Choose(self.focused)
    elseif handled then
      local target = self.focused
      if key == "HOME" then target = 1
      elseif key == "END" then target = #self.options
      else target = target + ((key == "UP" or key == "PAGEUP") and -1 or 1) * ((key == "PAGEUP" or key == "PAGEDOWN") and maxRows or 1) end
      self.focused = math.max(1, math.min(target, #self.options))
      if self.focused <= self.offset then self.offset = self.focused - 1
      elseif self.focused > self.offset + maxRows then self.offset = self.focused - maxRows end
      self.Refresh()
    end
  end)
  dropdown:SetScript("OnEvent", function(self)
    if not self:IsMouseOver() and not control:IsMouseOver() then self:Hide() end
  end)
  dropdown:SetScript("OnShow", function(self)
    self:RegisterEvent("GLOBAL_MOUSE_DOWN")
    if not IsInCombat() then self:SetPropagateKeyboardInput(true) end
  end)
  dropdown:SetScript("OnHide", function(self)
    self:UnregisterEvent("GLOBAL_MOUSE_DOWN")
    if UI.openSelector == self then UI.openSelector = nil end
    self.options = {}
  end)
  dropdown:Hide()
  control:SetScript("OnClick", function()
    if IsImportBusy() or IsInCombat() then return end
    local wasOpen = UI.openSelector == dropdown
    CloseSelectorMenu()
    if wasOpen then return end
    DisarmCloseAfterCopy()
    if UI.importBox then UI.importBox:ClearFocus() end
    dropdown.options = dropdown.getOptions()
    if #dropdown.options == 0 then return end
    dropdown.focused = 1
    for index, option in ipairs(dropdown.options) do if option.checked then dropdown.focused = index; break end end
    dropdown.offset = math.max(0, dropdown.focused - maxRows)
    dropdown.Refresh()
    UI.openSelector = dropdown
    dropdown:Show()
  end)
  control:SetScript("OnEnter", function() control:SetBackdropBorderColor(.5, .55, .61, 1) end)
  control:SetScript("OnLeave", function() control:SetBackdropBorderColor(unpack(COLORS.border)) end)
  return dropdown, control
end

ApplyOptionalSkin = function()
  if not skin or not UI.frame then return end
  -- Optional visual integration must not affect recommendation/import behavior.
  -- All frames are ours; no Blizzard Talents frames are modified by these calls.
  pcall(function()
    skin.Shell(UI.frame, { noTopBar = true, noBorder = true })
    skin.Panel(UI.card)
    skin.Panel(UI.modeDropdown)
    skin.Panel(UI.encounterDropdown)
    skin.Dropdown(UI.modeDropdown.control)
    skin.Dropdown(UI.encounterDropdown.control)
    skin.Button(UI.selectButton)
    skin.StateButtonLabel(UI.selectButton)
    skin.EditBox(UI.importBox)
    skin.Checkbox(UI.autoOpenCheckbox)
    skin.CloseButton(UI.closeButton)
    for _, font in ipairs(UI.fonts or {}) do skin.Font(font) end
  end)
end

if EllesmereUI and type(EllesmereUI.RegisterSkin) == "function" then
  pcall(EllesmereUI.RegisterSkin, ADDON_NAME, function(api)
    skin = api
    ApplyOptionalSkin()
  end)
end

local function CreateMainFrame()
  if UI.frame then return UI.frame end
  local frame = CreateFrame("Frame", ADDON_NAME .. "Frame", UIParent, "BackdropTemplate")
  frame:SetSize(WINDOW_WIDTH, WINDOW_HEIGHT)
  frame:SetPoint("CENTER")
  frame:SetFrameStrata("DIALOG")
  frame:SetMovable(true)
  frame:EnableMouse(true)
  FlatPanel(frame, COLORS.background, COLORS.border)
  if type(UISpecialFrames) == "table" then UISpecialFrames[#UISpecialFrames + 1] = ADDON_NAME .. "Frame" end
  frame:Hide()
  frame:SetScript("OnHide", function()
    CloseSelectorMenu()
    if UI.autoOpenedContextKey then
      UI.dismissedAutoOpenKey = UI.autoOpenedContextKey
      UI.autoOpenedContextKey = nil
    end
    DisarmCloseAfterCopy()
    if UI.importBox then UI.importBox:ClearFocus() end
  end)
  UI.frame = frame
  -- Only the header drags the window, so selecting/copying text cannot move it.
  local header = CreateFrame("Frame", nil, frame, "BackdropTemplate")
  header:SetPoint("TOPLEFT", 1, -1)
  header:SetPoint("TOPRIGHT", -1, -1)
  header:SetHeight(53)
  FlatPanel(header, COLORS.header, COLORS.header)
  header:EnableMouse(true)
  header:RegisterForDrag("LeftButton")
  header:SetScript("OnDragStart", function() frame:StartMoving() end)
  header:SetScript("OnDragStop", function() frame:StopMovingOrSizing() end)
  local rule = Solid(header, COLORS.rule)
  rule:SetHeight(1)
  rule:SetPoint("BOTTOMLEFT")
  rule:SetPoint("BOTTOMRIGHT")
  local logo = header:CreateTexture(ADDON_NAME .. "Logo", "ARTWORK")
  logo:SetTexture("Interface\\AddOns\\" .. ADDON_NAME .. "\\Media\\Logo.tga")
  logo:SetSize(32, 32)
  logo:SetPoint("LEFT", 17, 0)
  UI.logo = logo
  local title = Label(header, nil, 20)
  title:SetPoint("LEFT", logo, "RIGHT", 10, 6)
  title:SetText("Quick|cffaebac4WoW|rTalents")
  UI.title = title
  local tagline = Label(header, nil, 10, COLORS.muted)
  tagline:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 1, -2)
  tagline:SetText("YOUR NEXT BUILD. ONE CLICK.")
  local closeButton = CreateFrame("Button", nil, header)
  closeButton:SetSize(28, 28)
  closeButton:SetPoint("RIGHT", -10, 0)
  for _, angle in ipairs({ -math.pi / 4, math.pi / 4 }) do
    local line = Solid(closeButton, COLORS.muted)
    line:SetSize(13, 1.5)
    line:SetPoint("CENTER")
    line:SetRotation(angle)
  end
  closeButton:SetScript("OnClick", function() frame:Hide() end)
  UI.closeButton = closeButton

  local iconFrame = CreateFrame("Frame", nil, frame)
  iconFrame:SetSize(32, 32)
  iconFrame:SetPoint("TOPLEFT", 18, -68)
  local specIcon = iconFrame:CreateTexture(nil, "ARTWORK")
  specIcon:SetAllPoints()
  specIcon:SetTexCoord(.08, .92, .08, .92)
  UI.specIcon = specIcon
  local specLine = Label(frame, nil, 18)
  specLine:SetPoint("TOPLEFT", 62, -65)
  specLine:SetWidth(440)
  UI.specLine = specLine
  local currentLabel = Label(frame, nil, 12, COLORS.muted)
  currentLabel:SetPoint("TOPLEFT", 62, -88)
  currentLabel:SetText("Your current specialization")

  local modeLabel = Label(frame, nil, 11, COLORS.muted)
  modeLabel:SetPoint("TOPLEFT", 18, -112)
  modeLabel:SetText("CONTENT")
  UI.modeLabel = modeLabel
  local modeDropdown, modeControl = CreateSelector(frame, ADDON_NAME .. "ModeDropdown", 136, InitializeModeDropdown)
  modeControl:SetPoint("TOPLEFT", 18, -128)
  modeControl:SetHeight(30)
  UI.modeDropdown = modeDropdown
  local encounterLabel = Label(frame, nil, 11, COLORS.muted)
  encounterLabel:SetPoint("TOPLEFT", 164, -112)
  encounterLabel:SetText("Dungeon")
  UI.encounterLabel = encounterLabel
  local encounterDropdown, encounterControl = CreateSelector(frame, ADDON_NAME .. "EncounterDropdown", 338, InitializeEncounterDropdown)
  encounterControl:SetPoint("TOPLEFT", 164, -128)
  encounterControl:SetHeight(30)
  UI.encounterDropdown = encounterDropdown

  local card = CreateFrame("Frame", nil, frame, "BackdropTemplate")
  card:SetPoint("TOPLEFT", 18, -168)
  card:SetSize(484, 70)
  FlatPanel(card, COLORS.surface, COLORS.rule)
  UI.card = card
  local buildLabel = Label(card, nil, 11, COLORS.muted)
  buildLabel:SetPoint("TOPLEFT", 12, -9)
  buildLabel:SetWidth(460)
  UI.buildLabel = buildLabel
  local subtitle = Label(card, nil, 18)
  subtitle:SetPoint("TOPLEFT", 12, -25)
  subtitle:SetWidth(460)
  subtitle:SetHeight(22)
  subtitle:SetWordWrap(false)
  UI.subtitle = subtitle
  local meta = Label(card, nil, 12, COLORS.muted)
  meta:SetPoint("TOPLEFT", 12, -49)
  meta:SetWidth(460)
  UI.meta = meta

  local importButton = ActionButton(frame, ADDON_NAME .. "ImportButton", "Add & Use Build", true)
  importButton:SetSize(310, 34)
  importButton:SetPoint("TOPLEFT", 18, -248)
  importButton:SetScript("OnClick", ImportSelectedBuild)
  UI.importButton = importButton
  local selectButton = ActionButton(frame, ADDON_NAME .. "CopyButton", "Copy Build", false)
  selectButton:SetSize(164, 34)
  selectButton:SetPoint("TOPLEFT", 338, -248)
  selectButton:SetScript("OnClick", function() SelectImportText(true) end)
  UI.selectButton = selectButton

  local hint = Label(frame, ADDON_NAME .. "Status", 12, COLORS.muted)
  hint:SetPoint("TOPLEFT", 18, -314)
  hint:SetWidth(484)
  hint:SetHeight(36)
  hint:SetWordWrap(true)
  hint:SetText("Add and apply this build, replacing any pending talent edits.")
  UI.hint = hint

  local copyPanel = CreateFrame("Frame", ADDON_NAME .. "CopyPanel", frame)
  copyPanel:SetPoint("TOPLEFT", 18, -356)
  copyPanel:SetSize(484, 34)
  copyPanel:Hide()
  UI.copyPanel = copyPanel
  local importBox = CreateFrame("EditBox", ADDON_NAME .. "ImportBox", copyPanel, "BackdropTemplate")
  importBox:SetPoint("TOPLEFT")
  importBox:SetSize(484, 34)
  FlatPanel(importBox, COLORS.header, COLORS.border)
  importBox:SetFont("Fonts\\ARIALN.TTF", 12, "")
  importBox:SetTextColor(unpack(COLORS.muted))
  importBox:SetTextInsets(10, 10, 0, 0)
  importBox:SetAutoFocus(false)
  importBox:SetScript("OnEscapePressed", function(self) self:ClearFocus(); SetCopyPanelShown(false); DisarmCloseAfterCopy() end)
  importBox:SetScript("OnEditFocusGained", function(self) self:SetCursorPosition(0) end)
  importBox:SetScript("OnMouseUp", function() SelectImportText(true) end)
  importBox:SetScript("OnKeyDown", function(_, key)
    if UI.closeOnNextCopy and IsCopyModifierKey(key) then UI.copyModifierDown = true end
  end)
  importBox:SetScript("OnKeyUp", function(_, key)
    if IsCopyModifierKey(key) then
      C_Timer.After(0.2, function() UI.copyModifierDown = false end)
      return
    end
    if UI.closeOnNextCopy and UI.copyModifierDown and key == "C" then CloseAfterNativeCopy() end
  end)
  UI.importBox = importBox

  local autoOpenCheckbox = CreateFrame("CheckButton", ADDON_NAME .. "AutoOpenCheckbox", frame, "BackdropTemplate")
  autoOpenCheckbox:SetSize(18, 18)
  autoOpenCheckbox:SetPoint("BOTTOMLEFT", 18, 36)
  FlatPanel(autoOpenCheckbox, COLORS.surface, COLORS.border)
  autoOpenCheckbox:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
  autoOpenCheckbox:GetCheckedTexture():SetVertexColor(.85, .9, .95)
  autoOpenCheckbox:SetChecked(DB.autoOpenEnabled ~= false)
  autoOpenCheckbox:SetScript("OnClick", function(self) SetAutoOpenEnabled(self:GetChecked() == true) end)
  local autoOpenLabel = Label(autoOpenCheckbox, nil, 12, COLORS.muted)
  autoOpenLabel:SetPoint("LEFT", autoOpenCheckbox, "RIGHT", 8, 0)
  autoOpenLabel:SetJustifyV("MIDDLE")
  autoOpenLabel:SetText("Open automatically on dungeon entry")
  UI.autoOpenCheckbox = autoOpenCheckbox

  local footer = Label(frame, nil, 11, COLORS.muted)
  footer:SetPoint("BOTTOMLEFT", 18, 14)
  footer:SetWidth(350)
  UI.footer = footer
  local website = Label(frame, nil, 11, COLORS.muted)
  website:SetPoint("BOTTOMRIGHT", -18, 14)
  website:SetText("quickwowtalents.com")
  CreateApplyProgress(frame)
  ApplyOptionalSkin()
  return frame
end

local function GetMplusContextFromClient()
  local challengeMapId = nil
  if C_ChallengeMode and C_ChallengeMode.GetActiveChallengeMapID then
    challengeMapId = C_ChallengeMode.GetActiveChallengeMapID()
    if challengeMapId and MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID[challengeMapId] then
      return MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID[challengeMapId], challengeMapId, "challenge-map"
    end
  end

  local inInstance, instanceType = IsInInstance()
  if not inInstance or instanceType ~= "party" then
    return nil, nil, "not-party-instance"
  end

  local _, _, _, _, _, _, _, instanceMapId = GetInstanceInfo()
  if instanceMapId and MPLUS_DUNGEON_BY_INSTANCE_MAP_ID[instanceMapId] then
    return MPLUS_DUNGEON_BY_INSTANCE_MAP_ID[instanceMapId], instanceMapId, "instance-map"
  end

  return nil, instanceMapId or challengeMapId, "unmapped-instance"
end

local function HasMplusRecommendationForSpec(specID, dungeonId)
  if GetDataCompatibilityError() then
    return false
  end
  local data = GetData() or {}
  local specEntry = data.recommendations and data.recommendations[specID]
  local recommendation = specEntry
    and specEntry.mplus
    and specEntry.mplus.encounters
    and specEntry.mplus.encounters[dungeonId]

  return type(recommendation) == "table" and recommendation.importString ~= nil
end

local function BuildAutoOpenContext(reason)
  local compatibilityError = GetDataCompatibilityError()
  if compatibilityError then
    return nil, compatibilityError
  end
  EnsureState()

  if DB.autoOpenEnabled == false then
    return nil, "disabled"
  end

  local context, clientMapId, source = GetMplusContextFromClient()
  if not context then
    return nil, source
  end

  local specID, specName, errorMessage = GetCurrentSpecInfo()
  if errorMessage then
    return nil, errorMessage
  end

  if not HasMplusRecommendationForSpec(specID, context.qwtDungeonId) then
    return nil, "no bundled Mythic+ recommendation for " .. tostring(specName) .. " / " .. tostring(context.name)
  end

  local zoneToken = UI.autoOpenZoneToken or 0
  return {
    key = tostring(zoneToken) .. ":mplus:" .. tostring(specID) .. ":" .. tostring(context.qwtDungeonId),
    reason = reason or "event",
    specID = specID,
    specName = specName,
    dungeonId = context.qwtDungeonId,
    dungeonName = context.name,
    clientMapId = clientMapId,
    source = source
  }, nil
end

local function OpenAutoRecommendation(context)
  if ReportDataCompatibilityError() then
    return false
  end
  if not context or not context.dungeonId then
    return false
  end

  if IsImportBusy() then
    UI.pendingAutoOpenReason = context.reason or "import-finished"
    return false
  end

  if UI.frame and UI.frame:IsShown() then
    return false
  end

  if UI.dismissedAutoOpenKey == context.key or UI.lastAutoOpenKey == context.key then
    return false
  end

  if IsInCombat() then
    UI.pendingAutoOpenContext = context
    return false
  end

  EnsureState()
  UI.state.mode = "mplus"
  UI.state.encounterIds.mplus = context.dungeonId
  SaveState()

  local frame = CreateMainFrame()
  UI.autoOpenedContextKey = context.key
  UI.lastAutoOpenKey = context.key
  UI.pendingAutoOpenContext = nil
  frame:Show()
  UpdateRecommendation(false)
  Print("opened " .. tostring(context.dungeonName) .. " build for " .. tostring(context.specName) .. ". Use " .. Identity.slash .. " auto off to disable automatic opening.")
  return true
end

local function TryAutoOpen(reason)
  local context, errorMessage = BuildAutoOpenContext(reason)
  if context then
    OpenAutoRecommendation(context)
  elseif errorMessage == DATA_UPDATE_REQUIRED_MESSAGE then
    ReportDataCompatibilityError()
  end
end

ScheduleAutoOpenCheck = function(reason)
  if ReportDataCompatibilityError() then
    return
  end
  EnsureState()
  if DB.autoOpenEnabled == false then
    return
  end
  if IsImportBusy() then
    UI.pendingAutoOpenReason = reason
    return
  end

  UI.autoOpenCheckToken = (UI.autoOpenCheckToken or 0) + 1
  local token = UI.autoOpenCheckToken
  C_Timer.After(AUTO_OPEN_DELAY_SECONDS, function()
    if UI.autoOpenCheckToken == token then
      TryAutoOpen(reason)
    end
  end)
end

local function ShowRecommendation()
  if ReportDataCompatibilityError() then
    return
  end
  if IsInCombat() then
    Print("can't open during combat. Try " .. Identity.slash .. " again when combat ends.")
    return
  end

  EnsureState()
  local frame = CreateMainFrame()
  frame:Show()
  UpdateRecommendation(false)
  RefreshApplyProgress()
end

SetAutoOpenEnabled = function(enabled)
  EnsureState()
  DB.autoOpenEnabled = enabled
  UI.pendingAutoOpenContext = nil
  UI.pendingAutoOpenReason = nil
  UI.dismissedAutoOpenKey = nil
  UI.lastAutoOpenKey = nil
  UI.autoOpenCheckToken = (UI.autoOpenCheckToken or 0) + 1
  if UI.autoOpenCheckbox then UI.autoOpenCheckbox:SetChecked(enabled) end

  if enabled then
    Print("auto-open enabled. The addon will open once when you enter a supported Mythic+ dungeon with a bundled build.")
    ScheduleAutoOpenCheck("slash")
  else
    Print("auto-open disabled. Use " .. Identity.slash .. " to open manually or " .. Identity.slash .. " auto on to enable it again.")
  end
end

local function ShowAutoOpenStatus()
  EnsureState()
  local status = DB.autoOpenEnabled == false and "disabled" or "enabled"
  Print("auto-open is " .. status .. ". Commands: " .. Identity.slash .. " auto on, " .. Identity.slash .. " auto off, " .. Identity.slash .. " auto status.")
end

local function ShowInfo()
  local data = GetData() or {}
  local counts = data.counts or {}
  local mplusCount = data.modes and data.modes.mplus and data.modes.mplus.dungeons and #data.modes.mplus.dungeons or 0
  local raidCount = data.modes and data.modes.raid and data.modes.raid.bosses and #data.modes.raid.bosses or 0
  local raidDifficulty = data.modes and data.modes.raid and data.modes.raid.difficulty and data.modes.raid.difficulty.name or "Heroic"

  Print("loaded. Bundled import strings: " .. CountRecommendations() .. ".")
  Print("M+: " .. tostring(mplusCount) .. " dungeons, Best Overall only. Raid: " .. tostring(raidCount) .. " bosses, " .. tostring(raidDifficulty) .. " only.")
  Print("Data source: " .. tostring(data.source or "unknown") .. "; skipped: " .. tostring(counts.skipped or 0) .. ".")
  ShowAutoOpenStatus()
end

local function ShowImportStatus()
  if not NS.TalentImport then
    Print("Talent importing is unavailable. Select the import string to copy it.")
    return
  end
  local status = NS.TalentImport.GetStatus()
  Print("Import " .. tostring(status.phase) .. ": " .. tostring(status.message))
  if type(status.remainingCount) == "number" and status.remainingCount > 0 then
    Print("Previous QWT loadouts pending cleanup: " .. tostring(status.remainingCount) .. ".")
  end
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:RegisterEvent("PLAYER_REGEN_DISABLED")
eventFrame:RegisterEvent("PLAYER_REGEN_ENABLED")
eventFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
eventFrame:RegisterEvent("ZONE_CHANGED_NEW_AREA")
eventFrame:RegisterEvent("PLAYER_SPECIALIZATION_CHANGED")
eventFrame:RegisterEvent("CHALLENGE_MODE_START")
eventFrame:RegisterEvent("CHALLENGE_MODE_RESET")
eventFrame:SetScript("OnEvent", function(_, event, addonName)
  if event == "ADDON_LOADED" and addonName == ADDON_NAME then
    DB = GetSavedState()
    EnsureState()
  elseif event == "PLAYER_ENTERING_WORLD" then
    UI.autoOpenZoneToken = (UI.autoOpenZoneToken or 0) + 1
    ScheduleAutoOpenCheck(event)
  elseif event == "PLAYER_SPECIALIZATION_CHANGED" then
    local unit = addonName
    if not unit or unit == "player" then
      if UI.frame and UI.frame:IsShown() then UpdateRecommendation(false) end
      ScheduleAutoOpenCheck(event)
    end
  elseif event == "ZONE_CHANGED_NEW_AREA" or event == "CHALLENGE_MODE_START" or event == "CHALLENGE_MODE_RESET" then
    ScheduleAutoOpenCheck(event)
  elseif event == "PLAYER_REGEN_DISABLED" and UI.frame and UI.frame:IsShown() then
    UI.frame:Hide()
    Print("hidden for combat. Run " .. Identity.slash .. " again when combat ends.")
  elseif event == "PLAYER_REGEN_ENABLED" and UI.pendingAutoOpenContext then
    UI.pendingAutoOpenContext = nil
    TryAutoOpen(event)
  end
end)

local slashKey = string.upper(ADDON_NAME)
_G["SLASH_" .. slashKey .. "1"] = Identity.slash
_G["SLASH_" .. slashKey .. "2"] = "/quickwowtalents"
SlashCmdList[slashKey] = function(message)
  local command = string.lower(strtrim(message or ""))
  if command == "info" or command == "version" then
    ShowInfo()
  elseif command == "import status" then
    ShowImportStatus()
  elseif command == "auto" or command == "auto status" then
    ShowAutoOpenStatus()
  elseif command == "auto on" or command == "auto enable" then
    SetAutoOpenEnabled(true)
  elseif command == "auto off" or command == "auto disable" then
    SetAutoOpenEnabled(false)
  elseif command == "hide" then
    if UI.frame then UI.frame:Hide() end
  else
    ShowRecommendation()
  end
end

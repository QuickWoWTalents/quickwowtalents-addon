local ADDON_NAME = ...
local PREFIX = "|cff00c8ffQuick WoW Talents|r"
local UI = {}

local function Print(message)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. ": " .. tostring(message))
end

local function CountRecommendations()
  local data = QuickWoWTalentsData or {}
  local count = 0

  if type(data.recommendations) == "table" then
    for _, entry in pairs(data.recommendations) do
      if type(entry) == "table" and type(entry.mplusBestOverall) == "table" and entry.mplusBestOverall.importString then
        count = count + 1
      end
    end
  end

  return count
end

local function GetCurrentSpecInfo()
  if not GetSpecialization or not GetSpecializationInfo then
    return nil, nil, "Specialization API is not available."
  end

  local specIndex = GetSpecialization()
  if not specIndex then
    return nil, nil, "Choose a specialization first, then run /qwt again."
  end

  local specID, specName = GetSpecializationInfo(specIndex)
  if not specID then
    return nil, nil, "Could not detect current specialization."
  end

  return specID, specName, nil
end

local function GetRecommendation()
  local data = QuickWoWTalentsData or {}
  local specID, specName, errorMessage = GetCurrentSpecInfo()
  if errorMessage then
    return nil, errorMessage
  end

  local entry = data.recommendations and data.recommendations[specID]
  local recommendation = entry and entry.mplusBestOverall
  if not recommendation or not recommendation.importString then
    return nil, "No bundled recommendation for " .. tostring(specName) .. " (spec ID " .. tostring(specID) .. "). Data has " .. CountRecommendations() .. " specs."
  end

  return recommendation, nil
end

local function SelectImportText()
  if UI.importBox then
    UI.importBox:SetFocus()
    UI.importBox:HighlightText()
  end
end

local function CreateMainFrame()
  if UI.frame then
    return UI.frame
  end

  local frame = CreateFrame("Frame", "QuickWoWTalentsFrame", UIParent, "BackdropTemplate")
  frame:SetSize(680, 260)
  frame:SetPoint("CENTER")
  frame:SetFrameStrata("DIALOG")
  frame:SetMovable(true)
  frame:EnableMouse(true)
  frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", frame.StartMoving)
  frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
  frame:SetBackdrop({
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true,
    tileSize = 32,
    edgeSize = 32,
    insets = { left = 10, right = 10, top = 10, bottom = 10 }
  })
  frame:Hide()

  local closeButton = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
  closeButton:SetPoint("TOPRIGHT", -6, -6)

  local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 24, -22)
  title:SetText("Quick WoW Talents")
  UI.title = title

  local subtitle = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  subtitle:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -10)
  subtitle:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  subtitle:SetJustifyH("LEFT")
  UI.subtitle = subtitle

  local meta = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  meta:SetPoint("TOPLEFT", subtitle, "BOTTOMLEFT", 0, -8)
  meta:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  meta:SetJustifyH("LEFT")
  UI.meta = meta

  local importBox = CreateFrame("EditBox", nil, frame, "InputBoxTemplate")
  importBox:SetPoint("TOPLEFT", meta, "BOTTOMLEFT", 0, -18)
  importBox:SetSize(620, 32)
  importBox:SetAutoFocus(false)
  importBox:SetFontObject(ChatFontNormal)
  importBox:SetScript("OnEscapePressed", importBox.ClearFocus)
  importBox:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
  importBox:SetScript("OnMouseUp", function(self) self:SetFocus(); self:HighlightText() end)
  UI.importBox = importBox

  local selectButton = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
  selectButton:SetSize(120, 26)
  selectButton:SetPoint("TOPLEFT", importBox, "BOTTOMLEFT", 0, -14)
  selectButton:SetText("Select text")
  selectButton:SetScript("OnClick", SelectImportText)
  UI.selectButton = selectButton

  local hint = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  hint:SetPoint("LEFT", selectButton, "RIGHT", 14, 0)
  hint:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  hint:SetJustifyH("LEFT")
  hint:SetText("Copy, then open Talents → Loadouts → Import and paste.")
  UI.hint = hint

  local footer = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  footer:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", 24, 22)
  footer:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  footer:SetJustifyH("LEFT")
  UI.footer = footer

  UI.frame = frame
  return frame
end

local function ShowRecommendation()
  local recommendation, errorMessage = GetRecommendation()
  if errorMessage then
    Print(errorMessage)
    return
  end

  local data = QuickWoWTalentsData or {}
  local frame = CreateMainFrame()
  local snapshot = recommendation.snapshotDate or "unknown snapshot"
  local generated = data.generatedAt or recommendation.generatedAt or "unknown generation time"
  local sampleCount = recommendation.sampleCount or 0
  local dungeonName = recommendation.dungeonName or (data.dungeon and data.dungeon.name) or "default dungeon"

  UI.subtitle:SetText(recommendation.label or ((recommendation.specName or "Current spec") .. " — Mythic+ Best Overall"))
  UI.meta:SetText("Dungeon: " .. dungeonName .. " · Metric: " .. tostring(recommendation.metric or "default") .. " · Samples: " .. tostring(sampleCount))
  UI.importBox:SetText(recommendation.importString or "")
  UI.footer:SetText("Snapshot: " .. tostring(snapshot) .. " · Bundled: " .. tostring(generated) .. " · Offline addon data; no live calls from WoW.")

  frame:Show()
  SelectImportText()
end

local function ShowInfo()
  local data = QuickWoWTalentsData or {}
  local dungeonName = data.dungeon and data.dungeon.name or "default dungeon"
  Print("loaded. Bundled recommendations: " .. CountRecommendations() .. ".")
  Print("Data source: " .. tostring(data.source or "unknown") .. "; dungeon: " .. tostring(dungeonName) .. ".")
  Print("Run /qwt to show the current spec import string.")
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:SetScript("OnEvent", function(_, event, addonName)
  if event == "ADDON_LOADED" and addonName == ADDON_NAME then
    QuickWoWTalentsDB = QuickWoWTalentsDB or {}
  end
end)

SLASH_QUICKWOWTALENTS1 = "/qwt"
SLASH_QUICKWOWTALENTS2 = "/quickwowtalents"
SlashCmdList.QUICKWOWTALENTS = function(message)
  local command = string.lower(strtrim(message or ""))
  if command == "info" or command == "version" then
    ShowInfo()
  elseif command == "hide" then
    if UI.frame then UI.frame:Hide() end
  else
    ShowRecommendation()
  end
end

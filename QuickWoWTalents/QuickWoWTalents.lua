local ADDON_NAME = ...
local PREFIX = "|cff00c8ffQuick WoW Talents|r"

local function Print(message)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. ": " .. tostring(message))
end

local function ShowHelp()
  local data = QuickWoWTalentsData or {}
  local count = 0

  if type(data.recommendations) == "table" then
    for _ in pairs(data.recommendations) do
      count = count + 1
    end
  end

  Print("addon loaded. Recommendations bundled: " .. count .. ".")
  Print("Data export/import-string lookup comes next.")
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, event, addonName)
  if event == "ADDON_LOADED" and addonName == ADDON_NAME then
    QuickWoWTalentsDB = QuickWoWTalentsDB or {}
  end
end)

SLASH_QUICKWOWTALENTS1 = "/qwt"
SLASH_QUICKWOWTALENTS2 = "/quickwowtalents"
SlashCmdList.QUICKWOWTALENTS = function()
  ShowHelp()
end

' WebChat2Local hidden launcher
' Launches desktop_app.py with pythonw.exe (no console window).
' The app shows a system-tray icon; close it from the tray menu (Exit).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Prefer the project venv's windowless python, fall back to PATH.
pythonw = "C:\Users\botsz\venv\Scripts\pythonw.exe"
If Not fso.FileExists(pythonw) Then pythonw = "pythonw.exe"

shell.CurrentDirectory = scriptDir
' Run window style 0 = hidden. pythonw has no window anyway; double safety.
shell.Run """" & pythonw & """ -X utf8 """ & scriptDir & "\desktop_app.py""", 0, False
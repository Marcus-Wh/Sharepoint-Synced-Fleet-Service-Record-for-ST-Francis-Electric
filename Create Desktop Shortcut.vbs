' Creates a Desktop shortcut that launches SF Service Record with the
' company logo as its icon. Safe to double-click multiple times.
'
' Uses native Windows Script Host (built into every Windows since 1998).
' No PowerShell, no admin rights, no quoting headaches.

Option Explicit

Dim shell, fso, scriptDir, electron, iconPath, shortcutPath, sc

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

' This script lives at the app root; use its own folder as the app dir.
scriptDir    = fso.GetParentFolderName(WScript.ScriptFullName)
electron     = scriptDir & "\node_modules\electron\dist\electron.exe"
iconPath     = scriptDir & "\assets\icon.ico"
shortcutPath = shell.SpecialFolders("Desktop") & "\SF Service Record.lnk"

If Not fso.FileExists(electron) Then
  MsgBox "electron.exe not found at:" & vbCrLf & vbCrLf & electron & vbCrLf & vbCrLf & _
         "Make sure the whole 'SF Service Record' folder was copied from the USB.", _
         vbCritical, "SF Service Record - Setup"
  WScript.Quit 1
End If

On Error Resume Next
Set sc = shell.CreateShortcut(shortcutPath)
sc.TargetPath       = electron
sc.Arguments        = """" & scriptDir & """"
sc.WorkingDirectory = scriptDir
sc.IconLocation     = iconPath
sc.Description      = "SFE Service Record"
sc.Save

If Err.Number <> 0 Then
  MsgBox "Could not create the shortcut:" & vbCrLf & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
         "Try running this file as Administrator (right-click -> Run as administrator).", _
         vbCritical, "SF Service Record - Setup"
  WScript.Quit 1
End If
On Error Goto 0

MsgBox "Desktop shortcut created!" & vbCrLf & vbCrLf & _
       "Look for the SF Service Record icon on your Desktop." & vbCrLf & _
       "Double-click it to start the app.", _
       vbInformation, "SF Service Record - Setup"

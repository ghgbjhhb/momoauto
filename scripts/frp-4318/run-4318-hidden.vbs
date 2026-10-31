Dim fileSystem, shell, folder
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
shell.Run Chr(34) & folder & "\frpc.exe" & Chr(34) & " -c " & Chr(34) & folder & "\frpc-hkcn2-4318.toml" & Chr(34), 7, False

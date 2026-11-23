Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\<YOU>\Documents\deepseek-harness\default-workspace\.runtime\webcall"
sh.Run """C:\Users\<YOU>\.dsh\qq-bridge\node.exe"" ""C:\Users\<YOU>\Documents\deepseek-harness\default-workspace\.runtime\webcall\server.mjs""", 0, False
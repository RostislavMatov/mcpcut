# mcpcut's terminal console in 45 seconds: a bare `mcpcut` on a terminal opens it.
# Servers, agents with their grants, a write held for approval and approved from the
# console, the journal's sessions and the hash chain checked.
# Regenerate from the repository root:  sh docs/demo/render.sh console
# (this tape writes frames; render.sh joins them into docs/demo/console.gif)
#
# The hidden part runs docs/demo/console-setup.sh: an install in /tmp with an empty
# HOME, two servers, two agents, a few calls and one write left waiting. `mcpcut`
# below is a shell function that opens the real console through console.exp,
# which plays the operator's clipboard on Ctrl+V (the admin token), so no token is
# typed into the recording. The held call is answered from the list (0.2.4).

Output "/tmp/mcpcut-demo-frames/"

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 720
Set Padding 16
Set Theme "Builtin Dark"
Set TypingSpeed 40ms
Set Framerate 10
Set WaitTimeout 5m

Hide
Type "export REPO=$PWD DEMO=/tmp/mcpcut-demo HOME=/tmp/mcpcut-demo/home npm_config_cache=/tmp/mcpcut-demo/npm-cache npm_config_update_notifier=false npm_config_fund=false PATH=/tmp/mcpcut-demo/prefix/bin:$PATH" Enter
Wait
Type "sh docs/demo/console-setup.sh && cd $DEMO" Enter
Wait
Type "mcpcut() { expect -f $REPO/docs/demo/console.exp; }; clear" Enter
Wait
Show

# Sign in: the token is pasted into a masked field.
Type "mcpcut" Enter
Sleep 2s
Ctrl+V
Sleep 1s
Enter
Sleep 2s

# Servers ▸ list
Type "3"
Sleep 1s
Enter
Sleep 3s

# Agents ▸ list: one key per agent, grants per server and tool
Type "5"
Sleep 1s
Enter
Sleep 4s

# Approvals: cursor's write_file waits for a human. Enter on list opens the rows,
# Enter on the request asks about it, y approves — no id is typed.
Type "9"
Sleep 1s
Enter
Sleep 3s
Enter
Sleep 3s
Type "y"
Sleep 4s

# Journal ▸ sessions
Tab
Sleep 1s
Enter
Sleep 3s

# Audit ▸ verify: the hash chain holds
Tab
Sleep 1s
Down
Sleep 500ms
Enter
Sleep 1s
Enter
Sleep 4s

Type "q"
Sleep 1s
Type "cat project/plan.md    # the write that waited is on disk" Enter
Sleep 3s
Type "# npm install -g mcpcut, then: mcpcut" Enter
Sleep 4s

Hide
Type "command mcpcut stop >/dev/null 2>&1" Enter
Wait

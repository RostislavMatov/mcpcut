# mcpcut with Claude Code: install from npm, put the project's MCP server behind
# mcpcut, and let the agent work — a read passes, a write asks you right in the
# session, the journal keeps both with the database password redacted.
# Regenerate from the repository root:  sh docs/demo/render.sh claude-code
# (this tape writes frames; render.sh joins them into docs/demo/claude-code.gif)
#
# Needs Claude Code signed in on the recording machine; the model's words differ
# from run to run. The hidden part runs docs/demo/claude-code-setup.sh: a project
# in /tmp with an empty HOME, so nothing of the recording machine shows. `claude`
# below is a shell function that starts the real Claude Code with the machine's
# sign-in but none of its own settings, plugins or MCP servers — only the
# project's .mcp.json — so the recording shows what a fresh install sees. Its own
# file and shell tools are turned off: mcpcut sees MCP calls, and the agent here
# should reach the files through the project's MCP server.

Output "/tmp/mcpcut-demo-frames/"

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 720
Set Padding 16
Set Theme "Builtin Dark"
Set TypingSpeed 30ms
Set Framerate 10
Set WaitTimeout 3m

Hide
Type `export REPO=$PWD DEMO=/tmp/mcpcut-demo REAL_HOME=$HOME && unset $(env | sed -n 's/^\(CLAUDE[A-Z_]*\)=.*/\1/p')` Enter
Wait
Type "export HOME=$DEMO/home MCPCUT_DATA_DIR=$DEMO/home/.mcpcut/data npm_config_cache=$DEMO/npm-cache npm_config_prefix=$DEMO/prefix npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false PATH=$DEMO/prefix/bin:$PATH" Enter
Wait
Type "sh docs/demo/claude-code-setup.sh && cd $DEMO/home/project" Enter
Wait
Type `claude() { HOME=$REAL_HOME command claude --setting-sources project --strict-mcp-config --mcp-config .mcp.json --disallowedTools "Bash Read Write Edit Glob Grep" --model sonnet "$@"; }` Enter
Wait
Type `latest() { mcpcut sessions 2>/dev/null | awk 'NR>1' | sort -k2 | tail -1 | cut -d' ' -f1; }` Enter
Wait
# Claude Code asks once whether to trust a new folder: answered here, off camera.
# Down and Enter also do nothing harmful at an empty prompt, when it was trusted before.
Type "claude" Enter
Wait+Screen@90s /trust this folder|Try "/
Sleep 2s
Down
Sleep 500ms
Enter
Sleep 2s
Wait+Screen@90s /shortcuts|Try "/
Type "/exit" Enter
Wait
Type "clear" Enter
Wait
Show

Type "# Claude Code in this project uses an MCP server, fs. Put mcpcut in front of it:" Enter
Sleep 500ms
Type "npm install -g mcpcut" Enter
Wait
Sleep 1s
Type "mcpcut adopt --apply" Enter
Wait
Sleep 3s

Type "# Let calls pass, but ask me in the session before a write" Enter
Sleep 500ms
Type "cat > ~/.mcpcut/data/policy.json <<'EOF'" Enter
Type `{ "version": 1, "defaultDecision": "allow", "quarantine": { "enabled": false },` Enter
Type `  "servers": { "fs": { "confirmInClient": { "write_file": ["*"], "edit_file": ["*"] } } } }` Enter
Type "EOF" Enter
Wait
Sleep 2s

# VHS matches Wait+Screen against the first screenful of the buffer, so Claude Code starts on a cleared one.
Hide
Type "clear" Enter
Wait
Show
Type "claude" Enter
Wait+Screen@90s /shortcuts|Try "/
Sleep 1s
Type "Use the fs tools: read notes.md, then write its next steps to todo.md as a checklist" Enter
Wait+Screen@3m /Accept/
Sleep 3s
Enter
Sleep 10s
Type "/exit" Enter
Wait
Hide
Type "clear" Enter
Wait
Show

Type "# Every call is in the journal, the password redacted" Enter
Sleep 500ms
Type "mcpcut sessions" Enter
Wait
Sleep 2s
Type "mcpcut show $(latest) | grep -m1 -o 'postgres://[^@]*@[a-z.]*'" Enter
Wait
Sleep 2s
Type "mcpcut show $(latest) --kind decision | grep -v tools/list | grep -o 'outcome=[^{]*'" Enter
Wait
Sleep 6s

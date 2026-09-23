# mcpcut in 60 seconds — the Quick start of README.md, recorded.
# Regenerate from the repository root:  sh docs/demo/render.sh
# (this tape writes frames; render.sh joins them into docs/demo/quickstart.gif)
# The hidden part installs mcpcut from a tarball of this tree into /tmp,
# with an empty HOME, so nothing of the recording machine shows. The agent is
# the MCP Inspector CLI (deterministic, no account); versions are pinned.

Output "/tmp/mcpcut-demo-frames/"

Set Shell bash
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 16
Set Theme "Builtin Dark"
Set TypingSpeed 25ms
Set Framerate 10
Set WaitTimeout 3m

Hide
Type "export DEMO=/tmp/mcpcut-demo && rm -rf $DEMO && mkdir -p $DEMO/home $DEMO/project && npm pack --silent --pack-destination $DEMO >/dev/null 2>&1" Enter
Wait
Type "export HOME=$DEMO/home npm_config_cache=$DEMO/npm-cache npm_config_update_notifier=false npm_config_fund=false PATH=$DEMO/prefix/bin:$PATH && npm i -g --silent --prefix $DEMO/prefix $DEMO/mcpcut-0.1.0.tgz >/dev/null 2>&1 && cd $DEMO" Enter
Wait
Type "cp $OLDPWD/docs/demo/policy.json . && echo 'hello from the project' > project/notes.txt" Enter
Wait
Type `printf '{"mcpServers":{"fs":{"command":"mcpcut","args":["wrap","--policy","%s/policy.json","--","npx","-y","@modelcontextprotocol/server-filesystem@2026.8.31","%s/project"]}}}' $DEMO $DEMO > mcp.json` Enter
Wait
Type `agent() { npx -y @modelcontextprotocol/inspector@2.7.0 --cli --config mcp.json --server fs --method tools/call --tool-name "$@" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.content?.[0]?.text??JSON.stringify(r))})'; }` Enter
Wait
Type `latest() { mcpcut sessions | awk 'NR>1 && $1 !~ /^plane_/' | sort -k2 | tail -1 | cut -d' ' -f1; }` Enter
Wait
Type `pending() { mcpcut approvals list | awk 'NR==1{print $1}'; }` Enter
Wait
Type `outcomes() { node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>{const d=JSON.parse(l).decision;if(d&&d.toolName!=="tools/list")console.log(d.toolName.padEnd(16),d.outcome.padEnd(26),d.rule)})'; }` Enter
Wait
Type "set +m" Enter
Wait
Type "HOME=$DEMO/warm agent list_allowed_directories >/dev/null; rm -rf $DEMO/warm" Enter
Wait
Type "export MCP_ADMIN_TOKEN=$(mcpcut admin add me --role owner 2>/dev/null | sed -n 's/^token: //p') && mcpcut keygen >/dev/null 2>&1" Enter
Wait
Type "clear" Enter
Wait
Show

Type "# 1. See — an agent reads a file through mcpcut wrap" Enter
Sleep 500ms
Type "agent read_text_file --tool-arg path=$PWD/project/notes.txt" Enter
Wait
Sleep 2s
Type "mcpcut sessions | cut -c1-100" Enter
Wait
Sleep 3s

Type "# 2. Stop — reads pass, a write waits for you (policy.json)" Enter
Sleep 500ms
Type "agent write_file --tool-arg path=$PWD/project/out.txt --tool-arg content=approved > write.out &" Enter
Wait
Sleep 6s
Type "mcpcut approvals list | cut -c1-100" Enter
Wait
Sleep 3s
Type "mcpcut approvals approve $(pending) | cut -c1-100" Enter
Wait
Sleep 2s
Type "wait; cat write.out" Enter
Wait
Sleep 1s
Type "mcpcut show $(latest) --kind decision --json | outcomes" Enter
Wait
Sleep 4s

Type "# 3. Prove — export the history and check it offline" Enter
Sleep 500ms
Type "mcpcut export --report --out report | tail -2" Enter
Wait
Sleep 2s
Type "mcpcut verify --report report | grep -E '^ *\[|RESULT' | cut -c1-100" Enter
Wait
Sleep 6s

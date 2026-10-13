#!/bin/zsh
# Drives the installed B-Side through the paths that have caused double playing, extra copies
# or picture and sound from different videos, and checks the app after every step:
#   copies  running B-Side processes (must be 1, or 0 after quit)
#   sound   media elements playing in B-Side, from macOS power assertions (1 playing, 0 paused/off)
#   screens B-Side windows at desktop or screensaver level (one per player)
# Usage: tools/stress-test.sh            (needs bin/bside on PATH as `bside`)
# Changes what's playing. Doesn't touch Chrome unless CHROME=1.

A="https://www.youtube.com/watch?v=_JZom_gVfuw&list=RD_JZom_gVfuw"   # Juicy mix
B="https://www.youtube.com/watch?v=phaJXp_zMYM"                      # Big Poppa
C="https://www.youtube.com/watch?v=TIy3n2b7V9k"                      # Sk8er Boi
P="https://www.youtube.com/playlist?list=PL-jdGlB2ROPIlCx00C3A-o2K_KoAlWUmZ"
pass=0; fail=0

cmd() { osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('bside.cmd', $(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'), \$(), true)" >/dev/null; }
copies() { pgrep -f "B-Side.app/Contents/MacOS" | wc -l | tr -d ' '; }
sound() { pmset -g assertions | grep -E "\((applet|B-Side)\).*HTMLMediaElement playback" | wc -l | tr -d ' '; }
players() {
  osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); var a=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)), n=0;
    for (var i=0;i<a.count;i++){ var d=a.objectAtIndex(i), o=String(ObjC.unwrap(d.objectForKey("kCGWindowOwnerName"))), l=ObjC.unwrap(d.objectForKey("kCGWindowLayer"));
      if ((o=="B-Side"||o=="applet") && (l<-1000 || l>=1000)) n++; } n'
}
field() { bside status | python3 -c "import json,sys; d=json.load(sys.stdin); n=d.get('now') or {}; print({'id':n.get('id'),'title':(n.get('title') or '')[:40],'playing':n.get('playing'),'on':d.get('on'),'mode':d.get('mode'),'players':d.get('players'),'err':d.get('error')}.get('$1'))"; }

check() {   # check "label" copies sound players [expected id]
  local c=$(copies) s=$(sound) p=$(players) id="" ok=1
  [[ $c == $2 ]] || ok=0
  [[ $s == $3 ]] || ok=0
  [[ $p == $4 ]] || ok=0
  if [[ -n $5 ]]; then id=$(field id); [[ $id == $5 ]] || ok=0; fi
  if (( ok )); then pass=$((pass+1)); echo "PASS  $1  (copies $c, sound $s, players $p${5:+, id $id})"
  else fail=$((fail+1)); echo "FAIL  $1  (copies $c/$2, sound $s/$3, players $p/$4${5:+, id $id/$5}) $(field title) err=$(field err)"; fi
}

echo "== launch"
RESUME=$(python3 -c "import json,os; print(int(json.load(open(os.path.expanduser('~/Library/Application Support/B-Side/state.json')))['settings'].get('resumeOnLaunch', False)))")
open /Applications/B-Side.app; sleep 10
check "fresh launch (resume on open: $RESUME)" 1 $RESUME $RESUME
open -n /Applications/B-Side.app; open /Applications/B-Side.app; open -n /Applications/B-Side.app; sleep 5
check "opened three more times" 1 $RESUME $RESUME

echo "== play and switch"
cmd "url:$A"; sleep 9;  check "play Juicy mix" 1 1 1 _JZom_gVfuw
cmd "url:$B"; sleep 0.5; cmd "url:$C"; sleep 9; check "two links in half a second, last wins" 1 1 1 TIy3n2b7V9k
cmd "url:$P"; sleep 10; check "playlist-only link" 1 1 1
cmd "url:$A"; sleep 9
cmd next; sleep 0.3; cmd next; sleep 0.3; cmd next; sleep 8; check "next x3 fast" 1 1 1
cmd prev; sleep 7; check "previous" 1 1 1
cmd "recent:1"; sleep 9; check "play a recent" 1 1 1
printf '%s' "$B" | pbcopy; cmd pasteclip; sleep 9; check "paste from clipboard" 1 1 1 phaJXp_zMYM

echo "== controls"
cmd pause; sleep 3; check "pause" 1 0 1
cmd pause; sleep 4; check "play again" 1 1 1
cmd "hotkey:play"; sleep 3; check "shortcut pause" 1 0 1
cmd "hotkey:play"; sleep 4; check "shortcut play" 1 1 1
cmd mute; sleep 2; cmd mute; sleep 2; check "mute and unmute" 1 1 1
cmd "vol:30"; cmd "set:dim=40"; cmd "set:fill=false"; cmd "set:fill=true"; cmd "set:dim=20"; sleep 3; check "volume, dim, fill" 1 1 1

echo "== modes and screens"
for i in 1 2 3; do cmd screensaver; sleep 1.5; cmd wallpaper; sleep 1.5; done; sleep 2
check "wallpaper and screensaver x3" 1 1 1
cmd "hotkey:saver"; sleep 2; check "screensaver by shortcut" 1 1 1; cmd wallpaper; sleep 2
SCREENS=$(bside status | python3 -c 'import json,sys;print(json.load(sys.stdin)["screens"])')
cmd "set:screens=main"; sleep 8; check "main screen only" 1 1 1
cmd "set:screens=all"; sleep 8; check "all screens" 1 1 $SCREENS
cmd "set:skipStill=false"; cmd "set:skipStill=true"; sleep 3; check "still-skip toggled" 1 1 $SCREENS

echo "== off, on, quit"
cmd stop; sleep 3; check "turn off" 1 0 0
cmd resume; sleep 9; check "resume" 1 1 $SCREENS
cmd stop; sleep 1; cmd resume; sleep 1; cmd stop; sleep 1; cmd resume; sleep 9; check "off/on x2 fast" 1 1 $SCREENS
cmd quit; sleep 4; check "quit" 0 0 0
open /Applications/B-Side.app; sleep 4; cmd resume; sleep 9; check "relaunch and resume" 1 1 $SCREENS

if [[ $CHROME == 1 ]]; then
  echo "== Chrome hand-off"
  base=$(pmset -g assertions | grep -c "Google Chrome.*Playing audio")
  cmd tochrome; sleep 8; check "back to Chrome (B-Side off)" 1 0 0
  cmd on; sleep 10; check "take it back from Chrome" 1 1 $SCREENS
  now=$(pmset -g assertions | grep -c "Google Chrome.*Playing audio")
  [[ $now -le $base ]] && { pass=$((pass+1)); echo "PASS  Chrome not left playing ($now <= $base)"; } || { fail=$((fail+1)); echo "FAIL  Chrome still playing ($now > $base)"; }
fi

echo "== $pass passed, $fail failed"

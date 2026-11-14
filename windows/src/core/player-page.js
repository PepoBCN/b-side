'use strict';
// The embed player page. Same page as the Mac engine, plus input forwarding for screensaver mode.
const { parseUrl } = require('./url');

const ORIGIN = 'https://localhost.bside';

// The main player owns the playlist and the sound. Followers (other screens) are muted and
// copy whatever the main player shows, because YouTube mixes reshuffle on every load.
function embedSrc(url, follower) {
  const p = parseUrl(url);
  // Embed URL form, so a playlist or mix starts on this video rather than at its first track.
  const q = { enablejsapi: 1, autoplay: 1, controls: 0, cc_load_policy: 0, rel: 0, playsinline: 1, iv_load_policy: 3,
              fs: 0, disablekb: 1, origin: ORIGIN };
  if (p.t) q.start = p.t;
  if (!p.id) q.list = p.list;   // a playlist link with no video: start at its first track
  else if (!follower) {
    if (p.list) q.list = p.list; else { q.loop = 1; q.playlist = p.id; }
  }
  return 'https://www.youtube.com/embed/' + (p.id || 'videoseries') + '?' +
    Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
}

function playerPage(url, follower, settings, opts) {
  opts = opts || {};
  const p = parseUrl(url);
  const src = embedSrc(url, follower);
  const forceMute = !!opts.forceMute;
  const cfg = { id: p.id, list: p.list || '', follower: !!follower,
                volume: settings.volume, muted: forceMute || settings.muted, dim: settings.dim, fill: settings.fill };
  return `<!doctype html><html><head><meta charset="utf-8"><title>B-Side player</title><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}
#wrap{position:fixed;inset:0;overflow:hidden}
#p{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100vw;height:100vh;border:0;pointer-events:none}
body.fill #p{width:max(100vw,177.78vh);height:max(100vh,56.25vw)}
#dim{position:fixed;inset:0;background:#000;pointer-events:none;opacity:0;transition:opacity .3s}
${opts.transparent ? 'html,body,#wrap{background:#000!important}\n' : ''}</style></head><body><div id="wrap"><iframe id="p" src="${src}" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe></div><div id="dim"></div><script>
var C=${JSON.stringify(cfg)},player,ready=false,err=null;
function nocc(){try{player.unloadModule("captions");player.unloadModule("cc");}catch(e){}}
function setLook(dim,fill){document.getElementById("dim").style.opacity=dim/100;document.body.classList.toggle("fill",!!fill);}
setLook(C.dim,C.fill);
function onYouTubeIframeAPIReady(){
  player=new YT.Player("p",{events:{
    onReady:function(e){ready=true;nocc();
      if(C.follower||C.muted)e.target.mute();else{e.target.unMute();e.target.setVolume(C.volume);}
      e.target.playVideo();},
    onStateChange:function(e){nocc();if(e.data==1)err=null;},
    onApiChange:nocc,
    onError:function(e){err=e.data;if(!C.follower&&C.list)setTimeout(function(){player.nextVideo();},1500);}
  }});
}
function report(){try{var d=player.getVideoData();document.title=JSON.stringify({id:d.video_id,title:d.title,author:d.author,
  t:Math.floor(player.getCurrentTime()),d:Math.floor(player.getDuration()),s:player.getPlayerState(),
  i:player.getPlaylistIndex(),m:player.isMuted(),v:player.getVolume(),err:err});}catch(e){}}
setInterval(report,1000);
function toggle(){var st=player.getPlayerState();st==1||st==3||st==-1?player.pauseVideo():player.playVideo();}
function setVol(v){player.setVolume(v);if(v>0)player.unMute();}
function setMuted(m){m?player.mute():player.unMute();}
function follow(id,t,st){if(!ready)return;var d=player.getVideoData();
  if(d.video_id!==id){player.loadVideoById(id,t);return;}
  if(Math.abs(player.getCurrentTime()-t)>2)player.seekTo(t,true);
  var me=player.getPlayerState();if(st==2&&me==1)player.pauseVideo();if(st==1&&me!=1)player.playVideo();}
// Screensaver input goes to the app, which decides (grace period, 120 px of movement).
function sv(k,px){try{window.bsideInput&&window.bsideInput.send(k,px||0);}catch(e){}}
addEventListener("mousedown",function(){sv("click");},true);
addEventListener("contextmenu",function(){sv("click");},true);
addEventListener("keydown",function(){sv("key");},true);
addEventListener("mousemove",function(e){sv("move",Math.abs(e.movementX||0)+Math.abs(e.movementY||0));},true);
</script><script src="https://www.youtube.com/iframe_api"></script></body></html>`;
}

module.exports = { ORIGIN, embedSrc, playerPage };

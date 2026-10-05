// Throwaway static server for browser testing. Not part of the submission.
var http=require('http'),fs=require('fs'),path=require('path');
var root=path.resolve(__dirname,'..');
var types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
http.createServer(function(req,res){
  var u=decodeURIComponent(req.url.split('?')[0]); if(u==='/')u='/index.html';
  var f=path.join(root,u);
  fs.readFile(f,function(e,d){ if(e){res.writeHead(404);res.end('404');return;}
    res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'}); res.end(d); });
}).listen(8731,function(){console.log('serving on http://localhost:8731');});

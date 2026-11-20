# Varnish (the cache of Fastly, which serves GitHub Pages) in front of an origin that compresses.
# By default Varnish asks the origin for gzip, stores that, and decompresses for clients that do not accept gzip.
vcl 4.1;
backend default { .host = "nginx-gzip"; .port = "80"; }
sub vcl_backend_response {
    set beresp.ttl = 5s;
    set beresp.grace = 0s;
}
sub vcl_deliver {
    if (obj.hits > 0) { set resp.http.X-Cache-Status = "HIT"; } else { set resp.http.X-Cache-Status = "MISS"; }
}

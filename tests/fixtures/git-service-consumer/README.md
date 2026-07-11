# Git service consumer smoke fixture

This provider-free OpenTofu module declares a
`source.git.smart_http` consume and performs a real `git clone` during apply.
Takosumi injects the scoped URL, token, and repository prefix into the runner;
the token is sensitive and is never projected as an output.

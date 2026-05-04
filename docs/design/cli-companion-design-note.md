# CLI Companion Design Note

This note is non-normative. CLI is not the semantic authority.

A client may:

```text
read local manifest
select or display a Space from profile / auth context
send manifest for preview / resolve in that Space
package local source or artifact as requested by server
upload DataAsset bytes into the Space-visible artifact partition
show plans, risks, errors, and approval prompts
```

A client must not:

```text
install implementation code from manifest
execute arbitrary descriptor-provided code
make live descriptor web authority for apply
choose namespace exports outside the Space without server-side resolution
turn local paths into desired state without content-addressed DataAsset records
```

The server returns preparation requirements. The client fulfills them. The kernel records resolved DataAsset references in Space-scoped snapshots.

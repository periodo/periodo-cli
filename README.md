## Command line interface for working with PeriodO patches

```
Usage: periodo <command>

  where command is one of:

  list-patches
  submit-patch <patch file>
  reject-patch <patch url>
  create-bag   <json file> [<uuid>]

  To pipe patches or JSON via stdin use the filename '-'.

  To use a server other than canonical:

  -s --server <server url>
```

### Examples

List open and unmerged patches on the canonical server:
```
periodo list-patches
```

Create a bag of two period definitions on the staging server:
```
echo '{"title": "my test bag", "items": [ "p0z5nvh24r6", "p0vn2frn6dd" ]}' \
    | periodo -s https://staging.perio.do create-bag -
```

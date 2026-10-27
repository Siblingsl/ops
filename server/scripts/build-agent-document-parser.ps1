$ErrorActionPreference = 'Stop'
$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
try {
  $env:GOOS = 'wasip1'
  $env:GOARCH = 'wasm'
  go build -trimpath -ldflags '-s -w' -o internal/documentparse/parser.wasm ./internal/documentparse/wasm
  if ($LASTEXITCODE -ne 0) { throw 'document parser WASI build failed' }
  $parserSourceText = ''
  foreach ($parserSourcePath in @('internal/documentparse/wasm/main.go', 'go.mod', 'go.sum')) {
    $parserSourceText += [System.IO.File]::ReadAllText((Join-Path $PWD $parserSourcePath)).Replace("`r`n","`n")
  }
  $parserSourceHasher = [System.Security.Cryptography.SHA256]::Create()
  $parserSourceHash = [System.BitConverter]::ToString($parserSourceHasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($parserSourceText))).Replace('-','').ToLowerInvariant()
  $parserSourceHasher.Dispose()
  [System.IO.File]::WriteAllText((Join-Path $PWD 'internal/documentparse/parser-source.sha256'), $parserSourceHash)
} finally {
  $env:GOOS = $previousGOOS
  $env:GOARCH = $previousGOARCH
}

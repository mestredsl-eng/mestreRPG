# Encerramento controlado do Mestre RPG (chamado por parar-mestre-rpg.bat)
$ErrorActionPreference = 'SilentlyContinue'
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = 'http://localhost:3001'

# Segredo local (somente este computador consegue le-lo)
$segredo = $null
try { $segredo = (Get-Content (Join-Path $raiz 'configuracao\local.json') -Raw | ConvertFrom-Json).segredoLocal } catch { }
$headers = @{}
if ($segredo) { $headers['x-mestre-local'] = $segredo }

# 1) Solicita encerramento gracioso ao servidor
try {
    Invoke-RestMethod -Method Post -Uri "$base/api/local/desligar" -Headers $headers -TimeoutSec 5 | Out-Null
    Write-Host '[OK] Encerramento solicitado ao servidor.'
} catch {
    Write-Host '[AVISO] Nao foi possivel solicitar encerramento gracioso (servidor offline ou token invalido).'
}

# 2) Aguarda o servidor cair (ate ~20s)
$limite = (Get-Date).AddSeconds(20)
$ativo = $true
while ((Get-Date) -lt $limite) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$base/api/health" | Out-Null } catch { $ativo = $false; break }
    Start-Sleep -Milliseconds 700
}
if (-not $ativo) { Write-Host '[OK] Servidor encerrado.'; exit 0 }

# 3) Ainda ativo: mensagem clara e fallback controlado
Write-Host ''
Write-Host '[AVISO] O servidor nao encerrou no tempo esperado (possiveis conexoes em andamento).'
Write-Host '         Aguardando mais 5 segundos antes do encerramento forcado...'
Start-Sleep -Seconds 5
$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
    Write-Host '[OK] Processo encerrado (modo forcado).'
} else {
    Write-Host '[OK] Nenhum processo ouvindo na porta 3001.'
}

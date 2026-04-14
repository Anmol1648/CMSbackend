$basePath = "c:\Users\anmol\Desktop\erp\MainErp\cms\backend"
$entities = @("$basePath\api-gateway") + (Get-ChildItem -Path "$basePath\services" -Directory).FullName

foreach ($entity in $entities) {
    Write-Host "Polishing package.json for $entity..."
    
    $pjPath = "$entity\package.json"
    if (Test-Path $pjPath) {
        $pjContent = Get-Content $pjPath | ConvertFrom-Json
        
        # Ensure scripts object exists
        if (-not $pjContent.scripts) {
            $pjContent | Add-Member -MemberType NoteProperty -Name scripts -Value ([PSCustomObject]@{ })
        }
        
        # Add scripts via Add-Member to avoid PSCustomObject property assignment issues
        if (-not $pjContent.scripts.dev) {
            $pjContent.scripts | Add-Member -MemberType NoteProperty -Name dev -Value "tsx watch src/index.ts"
        } else {
            $pjContent.scripts.dev = "tsx watch src/index.ts"
        }
        
        if (-not $pjContent.scripts.build) {
            $pjContent.scripts | Add-Member -MemberType NoteProperty -Name build -Value "tsc"
        } else {
            $pjContent.scripts.build = "tsc"
        }

        # Update main to reflect it's now using JS in dist after build
        $pjContent.main = "dist/index.js"
        
        $pjContent | ConvertTo-Json -Depth 10 | Out-File -FilePath $pjPath -Encoding utf8 -Force
    }
}

Write-Host "Polishing finished."

$basePath = "c:\Users\anmol\Desktop\erp\MainErp\cms\backend"
$entities = @("$basePath\api-gateway") + (Get-ChildItem -Path "$basePath\services" -Directory).FullName

$tsConfigContent = @"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    },
    "outDir": "./dist",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
"@

foreach ($entity in $entities) {
    Write-Host "Migrating $entity..."
    
    # 1. Populate tsconfig.json
    $tsConfigContent | Out-File -FilePath "$entity\tsconfig.json" -Encoding utf8 -Force
    
    # 2. Update package.json
    $pjPath = "$entity\package.json"
    if (Test-Path $pjPath) {
        $pj = Get-Content $pjPath | ConvertFrom-Json
        $pj.scripts.dev = "tsx watch src/index.ts"
        $pj.scripts.build = "tsc"
        
        # Add devDependencies if not present
        if (-not $pj.devDependencies) { $pj | Add-Member -MemberType NoteProperty -Name devDependencies -Value @{} }
        $pj.devDependencies.typescript = "^5.4.5"
        $pj.devDependencies.tsx = "^4.10.2"
        $pj.devDependencies."@types/node" = "^20.12.12"
        $pj.devDependencies."@types/express" = "^4.17.21"
        $pj.devDependencies."@types/cors" = "^2.8.17"
        
        $pj | ConvertTo-Json -Depth 10 | Out-File -FilePath $pjPath -Encoding utf8 -Force
    }
    
    # 3. Migrate src/index.js to index.ts
    $jsPath = "$entity\src\index.js"
    $tsPath = "$entity\src\index.ts"
    if (Test-Path $jsPath) {
        $content = Get-Content $jsPath
        
        # Convert require to import (simple approach for our boilerplate)
        $newContent = $content -replace "const express = require\('express'\);", "import express from 'express';"
        $newContent = $newContent -replace "const cors = require\('cors'\);", "import cors from 'cors';"
        
        $newContent | Out-File -FilePath $tsPath -Encoding utf8 -Force
        Remove-Item $jsPath -Force
    }
}

Write-Host "Migration script finished."

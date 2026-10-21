-- CreateTable
CREATE TABLE "report_designs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "report_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "note" TEXT,
    "jrxml" TEXT NOT NULL,
    "info" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "report_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "report_key" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'auto',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "report_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_designs_tenant_id_report_key_idx" ON "report_designs"("tenant_id", "report_key");

-- CreateIndex
CREATE UNIQUE INDEX "report_designs_tenant_id_report_key_version_key" ON "report_designs"("tenant_id", "report_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "report_settings_tenant_id_report_key_key" ON "report_settings"("tenant_id", "report_key");

-- AddForeignKey
ALTER TABLE "report_designs" ADD CONSTRAINT "report_designs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_settings" ADD CONSTRAINT "report_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "user_dashboards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "widgets" JSONB,
    "links" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_dashboards_tenant_id_user_id_key" ON "user_dashboards"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "user_dashboards" ADD CONSTRAINT "user_dashboards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

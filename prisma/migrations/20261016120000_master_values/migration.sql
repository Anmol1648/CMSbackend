-- CreateTable
CREATE TABLE "master_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "master" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "master_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "master_values_tenant_id_master_parent_id_sort_order_idx" ON "master_values"("tenant_id", "master", "parent_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "master_values_id_tenant_id_key" ON "master_values"("id", "tenant_id");

-- AddForeignKey
ALTER TABLE "master_values" ADD CONSTRAINT "master_values_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_values" ADD CONSTRAINT "master_values_parent_id_tenant_id_fkey" FOREIGN KEY ("parent_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma can't express ------------------------------------------------

-- One name per list and parent, and one code per list (case-insensitive).
CREATE UNIQUE INDEX "master_values_name_key" ON "master_values"("tenant_id", "master", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"));
CREATE UNIQUE INDEX "master_values_code_key" ON "master_values"("tenant_id", "master", lower("code")) WHERE "code" IS NOT NULL;

ALTER TABLE "master_values" ADD CONSTRAINT "master_values_master_check" CHECK ("master" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "master_values" ADD CONSTRAINT "master_values_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 120);
ALTER TABLE "master_values" ADD CONSTRAINT "master_values_code_check" CHECK ("code" IS NULL OR ("code" = btrim("code") AND length("code") BETWEEN 1 AND 20));
ALTER TABLE "master_values" ADD CONSTRAINT "master_values_extra_check" CHECK (jsonb_typeof("extra") = 'object');

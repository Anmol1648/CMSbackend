-- AlterTable
ALTER TABLE "menu_customizations" ADD COLUMN     "group_key" TEXT,
ADD COLUMN     "icon" TEXT;

-- CreateTable
CREATE TABLE "menu_group_customizations" (
    "tenant_id" UUID NOT NULL,
    "group_key" TEXT NOT NULL,
    "label" TEXT,
    "sort_order" INTEGER,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "menu_group_customizations_pkey" PRIMARY KEY ("tenant_id","group_key")
);

-- CreateTable
CREATE TABLE "platform_menu_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL DEFAULT '[]',
    "groups" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_menu_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_menu_templates_name_key" ON "platform_menu_templates"("name");

-- AddForeignKey
ALTER TABLE "menu_group_customizations" ADD CONSTRAINT "menu_group_customizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

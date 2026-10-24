-- CreateTable
CREATE TABLE "upload_folders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inherit" BOOLEAN NOT NULL DEFAULT true,
    "audience" TEXT NOT NULL DEFAULT 'everyone',
    "role_slugs" TEXT[],
    "section_ids" UUID[],
    "user_ids" UUID[],
    "with_parents" BOOLEAN NOT NULL DEFAULT true,
    "staff_add" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "upload_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tag_ids" UUID[],
    "kind" TEXT NOT NULL DEFAULT 'file',
    "file_id" UUID,
    "link" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "inherit" BOOLEAN NOT NULL DEFAULT true,
    "audience" TEXT NOT NULL DEFAULT 'everyone',
    "role_slugs" TEXT[],
    "section_ids" UUID[],
    "user_ids" UUID[],
    "with_parents" BOOLEAN NOT NULL DEFAULT true,
    "valid_until" DATE,
    "needs_ack" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'published',
    "uploaded_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "upload_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "file_id" UUID,
    "link" TEXT,
    "file_name" TEXT,
    "uploaded_by" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "first_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opens" INTEGER NOT NULL DEFAULT 1,
    "acknowledged_at" TIMESTAMPTZ(6),
    "reminded_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "upload_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_folders_tenant_id_parent_id_idx" ON "upload_folders"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_folders_id_tenant_id_key" ON "upload_folders"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "upload_items_tenant_id_folder_id_idx" ON "upload_items"("tenant_id", "folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_items_id_tenant_id_key" ON "upload_items"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "upload_versions_tenant_id_item_id_idx" ON "upload_versions"("tenant_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_views_item_id_user_id_key" ON "upload_views"("item_id", "user_id");

-- AddForeignKey
ALTER TABLE "upload_folders" ADD CONSTRAINT "upload_folders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_items" ADD CONSTRAINT "upload_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_items" ADD CONSTRAINT "upload_items_folder_id_tenant_id_fkey" FOREIGN KEY ("folder_id", "tenant_id") REFERENCES "upload_folders"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_versions" ADD CONSTRAINT "upload_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_versions" ADD CONSTRAINT "upload_versions_item_id_tenant_id_fkey" FOREIGN KEY ("item_id", "tenant_id") REFERENCES "upload_items"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_views" ADD CONSTRAINT "upload_views_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_views" ADD CONSTRAINT "upload_views_item_id_tenant_id_fkey" FOREIGN KEY ("item_id", "tenant_id") REFERENCES "upload_items"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

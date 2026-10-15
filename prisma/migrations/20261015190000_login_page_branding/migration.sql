-- AlterTable
ALTER TABLE "school_profiles" ADD COLUMN     "login_background_file_id" UUID,
ADD COLUMN     "login_background_focus" TEXT NOT NULL DEFAULT 'center',
ADD COLUMN     "login_overlay" SMALLINT NOT NULL DEFAULT 60,
ADD COLUMN     "login_quote" TEXT,
ADD COLUMN     "login_quote_author" TEXT;

-- AddForeignKey
ALTER TABLE "school_profiles" ADD CONSTRAINT "school_profiles_login_background_file_id_fkey" FOREIGN KEY ("login_background_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Rules the database enforces itself.
ALTER TABLE "school_profiles"
  ADD CONSTRAINT "school_profiles_login_background_focus_check" CHECK ("login_background_focus" IN ('center', 'top', 'bottom', 'left', 'right')),
  ADD CONSTRAINT "school_profiles_login_overlay_check" CHECK ("login_overlay" BETWEEN 0 AND 90);

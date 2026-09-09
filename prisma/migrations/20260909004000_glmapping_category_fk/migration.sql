-- Add the missing Category FK on GLMapping.categoryId (#10). Previously a
-- plain string column: mappings could point at categories of another
-- organization. ON DELETE CASCADE removes the mapping with its category.
ALTER TABLE "GLMapping" ADD CONSTRAINT "GLMapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

package ru.krug.backend.file.infrastructure.persistence;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UploadPartJpaRepository
        extends JpaRepository<UploadPartEntity, UploadPartId> {

    @Query("""
            select p from UploadPartEntity p
             where p.id.uploadId = :uploadId
             order by p.id.partNo asc
            """)
    List<UploadPartEntity> findByUploadId(@Param("uploadId") UUID uploadId);

    @Modifying
    @Query("delete from UploadPartEntity p where p.id.uploadId = :uploadId")
    void deleteByUploadId(@Param("uploadId") UUID uploadId);
}

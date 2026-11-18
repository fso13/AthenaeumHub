package ru.krug.backend.ops.domain.repository;

import ru.krug.backend.ops.domain.model.PlatformOverview;

public interface PlatformOverviewRepository {

    /** Global counts through the SECURITY DEFINER function (admins are RLS-scoped to self). */
    PlatformOverview overview();
}

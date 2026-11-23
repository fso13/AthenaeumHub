package ru.krug.backend.ops.application.port;

import java.util.List;

import ru.krug.backend.ops.application.model.RetentionTarget;

/**
 * Lists ACTIVE workspaces with a retention policy (#101). The implementation runs under the
 * transaction-local retention worker role and calls a SQL function that returns settings
 * values only.
 */
public interface RetentionTargetDirectory {

    List<RetentionTarget> targets(int limit);
}

package ru.krug.backend.plugin.application.usecase;

import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.plugin.application.model.PluginView;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginKind;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;

/**
 * {@code GET /plugins}: the installed catalog (built-in and external packages). No
 * workspace or chat is required — the rows are catalog metadata, contain no secrets and
 * are not user content. {@code entry_url} is only emitted for external packages; it is
 * an authenticated API path, never a filesystem path or an object-storage presigned URL.
 */
@Service
public class ListPluginsService {

    private final PluginCatalogRepository catalog;

    public ListPluginsService(PluginCatalogRepository catalog) {
        this.catalog = catalog;
    }

    @Transactional(readOnly = true)
    public List<PluginView> list() {
        return catalog.findAll().stream().map(ListPluginsService::toView).toList();
    }

    static PluginView toView(Plugin plugin) {
        String entryUrl = plugin.kind() == PluginKind.EXTERNAL && plugin.entry() != null
                ? "/api/v1/plugins/" + plugin.id() + "/assets/" + plugin.entry()
                : null;
        return new PluginView(
                plugin.id(),
                plugin.name(),
                plugin.description(),
                plugin.icon(),
                plugin.permissions(),
                plugin.modes().stream().map(Enum::name).toList(),
                plugin.state().name(),
                plugin.kind().name(),
                plugin.version(),
                plugin.author(),
                entryUrl);
    }
}

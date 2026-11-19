package ru.krug.backend.plugin.application.usecase;

import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.plugin.application.model.PluginView;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;

/**
 * {@code GET /plugins}: the curated built-in catalog. No workspace or chat is required —
 * the rows are global first-party metadata, contain no secrets and are not user content.
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
        return new PluginView(
                plugin.id(),
                plugin.name(),
                plugin.description(),
                plugin.icon(),
                plugin.permissions().stream().map(Enum::name).toList(),
                plugin.modes().stream().map(Enum::name).toList(),
                plugin.state().name());
    }
}

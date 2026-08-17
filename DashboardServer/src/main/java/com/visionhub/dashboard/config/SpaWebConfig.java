package com.visionhub.dashboard.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.PathResourceResolver;

import java.io.IOException;

/**
 * Serves the React build (copied into src/main/resources/static at build
 * time - see DashboardServer/README) and falls back to index.html for any
 * path that isn't a real static file, so React Router's client-side routes
 * (e.g. /vision/5-2/Welding%20Cathode%20Vision) work on a hard refresh.
 * Controller-mapped paths (/api/**) are matched before this resource
 * handler regardless of the "/**" pattern here - Spring always prefers a
 * specific @RequestMapping over a resource handler.
 */
@Configuration
public class SpaWebConfig implements WebMvcConfigurer {
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/**")
                .addResourceLocations("classpath:/static/")
                .resourceChain(true)
                .addResolver(new PathResourceResolver() {
                    @Override
                    protected Resource getResource(String resourcePath, Resource location) throws IOException {
                        Resource requested = location.createRelative(resourcePath);
                        if (requested.exists() && requested.isReadable()) {
                            return requested;
                        }
                        return new ClassPathResource("/static/index.html");
                    }
                });
    }
}

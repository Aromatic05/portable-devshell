/** Use the local SVG symbol set rather than external fonts or image requests. */
export function icon(name: string): SVGSVGElement {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(namespace, "use");
    use.setAttribute("href", "#icon-" + name);
    svg.append(use);
    return svg;
}

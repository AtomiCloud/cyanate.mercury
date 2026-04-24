import { describe, expect, it } from "bun:test";
import { materializeShapeNormalizedChrome } from "./chrome-shape-materialize.js";

describe("materializeShapeNormalizedChrome", () => {
	it("materializes canonicals using source indices when available", () => {
		const chrome = {
			header: {
				nav: [{ link: "/" }, { link: "/about" }],
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "header.nav[0].link",
				suggestedCanonical: "header.nav[*].href",
			},
			{
				sourcePath: "header.nav[1].link",
				suggestedCanonical: "header.nav[*].href",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			header: {
				nav: [{ href: "/" }, { href: "/about" }],
			},
		});
		expect(result.provenance).toEqual([
			{
				sourcePath: "header.nav[0].link",
				candidatePath: "header.nav[*].href",
				materializedPath: "header.nav[0].href",
				syntheticIndices: [0],
			},
			{
				sourcePath: "header.nav[1].link",
				candidatePath: "header.nav[*].href",
				materializedPath: "header.nav[1].href",
				syntheticIndices: [1],
			},
		]);
	});

	it("keeps wildcard array order independent from input path order", () => {
		const chrome = {
			header: {
				nav: [{ link: "/" }, { link: "/about" }],
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "header.nav[1].link",
				suggestedCanonical: "header.nav[*].href",
			},
			{
				sourcePath: "header.nav[0].link",
				suggestedCanonical: "header.nav[*].href",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			header: {
				nav: [{ href: "/" }, { href: "/about" }],
			},
		});
	});

	it("binds nested wildcards to the matching source array depth", () => {
		const chrome = {
			header: {
				nav_links: [
					{ text: "Home" },
					{ text: "About" },
					{ text: "Team" },
					{
						children: [
							{ text: "A", url: "/a" },
							{ text: "B", url: "/b" },
						],
					},
				],
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "header.nav_links[3].children[0].text",
				suggestedCanonical: "header.nav_links[3].children[*].title",
			},
			{
				sourcePath: "header.nav_links[3].children[0].url",
				suggestedCanonical: "header.nav_links[3].children[*].href",
			},
			{
				sourcePath: "header.nav_links[3].children[1].text",
				suggestedCanonical: "header.nav_links[3].children[*].title",
			},
			{
				sourcePath: "header.nav_links[3].children[1].url",
				suggestedCanonical: "header.nav_links[3].children[*].href",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			header: {
				nav_links: [
					undefined,
					undefined,
					undefined,
					{
						children: [
							{ title: "A", href: "/a" },
							{ title: "B", href: "/b" },
						],
					},
				],
			},
		});
	});

	it("keeps nested wildcard index spaces separate for each parent item", () => {
		const chrome = {
			header: {
				nav: [
					{ label: "Home" },
					{
						label: "Services",
						children: [
							{ label: "Physio", href: "/physio" },
							{ label: "Massage", href: "/massage" },
						],
					},
					{
						label: "About",
						children: [
							{ label: "Team", href: "/team" },
							{ label: "Careers", href: "/careers" },
							{ label: "Contact", href: "/contact" },
						],
					},
				],
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "header.nav[1].children[0].label",
				suggestedCanonical: "header.nav[*].children[*].title",
			},
			{
				sourcePath: "header.nav[1].children[0].href",
				suggestedCanonical: "header.nav[*].children[*].href",
			},
			{
				sourcePath: "header.nav[1].children[1].label",
				suggestedCanonical: "header.nav[*].children[*].title",
			},
			{
				sourcePath: "header.nav[1].children[1].href",
				suggestedCanonical: "header.nav[*].children[*].href",
			},
			{
				sourcePath: "header.nav[2].children[0].label",
				suggestedCanonical: "header.nav[*].children[*].title",
			},
			{
				sourcePath: "header.nav[2].children[0].href",
				suggestedCanonical: "header.nav[*].children[*].href",
			},
			{
				sourcePath: "header.nav[2].children[1].label",
				suggestedCanonical: "header.nav[*].children[*].title",
			},
			{
				sourcePath: "header.nav[2].children[1].href",
				suggestedCanonical: "header.nav[*].children[*].href",
			},
			{
				sourcePath: "header.nav[2].children[2].label",
				suggestedCanonical: "header.nav[*].children[*].title",
			},
			{
				sourcePath: "header.nav[2].children[2].href",
				suggestedCanonical: "header.nav[*].children[*].href",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			header: {
				nav: [
					{
						children: [
							{ title: "Physio", href: "/physio" },
							{ title: "Massage", href: "/massage" },
						],
					},
					{
						children: [
							{ title: "Team", href: "/team" },
							{ title: "Careers", href: "/careers" },
							{ title: "Contact", href: "/contact" },
						],
					},
				],
			},
		});
	});

	it("materializes wildcard arrays densely even when source indices are sparse", () => {
		const chrome = {
			content_sections: Array.from({ length: 25 }, (_, i) =>
				i === 23
					? { title: "FAQ" }
					: i === 24
						? { title: "Start", content: "Book now" }
						: null,
			),
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "content_sections[23].title",
				suggestedCanonical: "content_sections[*].title",
			},
			{
				sourcePath: "content_sections[24].title",
				suggestedCanonical: "content_sections[*].title",
			},
			{
				sourcePath: "content_sections[24].content",
				suggestedCanonical: "content_sections[*].desc",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			content_sections: [
				{ title: "FAQ" },
				{ title: "Start", desc: "Book now" },
			],
		});
	});

	it("synthesizes stable indices when folding flat sibling families into arrays", () => {
		const chrome = {
			footer: {
				email_label: "Email",
				email_placeholder: "you@example.com",
				phone_label: "Phone",
				phone_placeholder: "555-1234",
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "footer.email_label",
				suggestedCanonical: "footer.form_fields[*].label",
			},
			{
				sourcePath: "footer.email_placeholder",
				suggestedCanonical: "footer.form_fields[*].placeholder",
			},
			{
				sourcePath: "footer.phone_label",
				suggestedCanonical: "footer.form_fields[*].label",
			},
			{
				sourcePath: "footer.phone_placeholder",
				suggestedCanonical: "footer.form_fields[*].placeholder",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			footer: {
				form_fields: [
					{ label: "Email", placeholder: "you@example.com" },
					{ label: "Phone", placeholder: "555-1234" },
				],
			},
		});
	});

	it("groups object member children into the same synthetic array item", () => {
		const chrome = {
			footer: {
				social: {
					facebook: { label: "Facebook", url: "/facebook" },
					instagram: { label: "Instagram", url: "/instagram" },
				},
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "footer.social.facebook.label",
				suggestedCanonical: "footer.social_links[*].label",
			},
			{
				sourcePath: "footer.social.facebook.url",
				suggestedCanonical: "footer.social_links[*].href",
			},
			{
				sourcePath: "footer.social.instagram.label",
				suggestedCanonical: "footer.social_links[*].label",
			},
			{
				sourcePath: "footer.social.instagram.url",
				suggestedCanonical: "footer.social_links[*].href",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			footer: {
				social_links: [
					{ label: "Facebook", href: "/facebook" },
					{ label: "Instagram", href: "/instagram" },
				],
			},
		});
	});

	it("reports collisions when multiple source paths collapse onto one target leaf", () => {
		const chrome = {
			footer: {
				address: ["Line 1", "Line 2"],
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "footer.address[0]",
				suggestedCanonical: "footer.address",
			},
			{
				sourcePath: "footer.address[1]",
				suggestedCanonical: "footer.address",
			},
		]);
		expect(result.collisions).toEqual([
			{
				materializedPath: "footer.address",
				firstSourcePath: "footer.address[0]",
				secondSourcePath: "footer.address[1]",
			},
		]);
	});

	it("tracks identity-key source paths without materializing them as leaves", () => {
		const chrome = {
			footer: {
				form: {
					fields: [{ name: "email", type: "email" }],
				},
			},
		};
		const result = materializeShapeNormalizedChrome(chrome, [
			{
				sourcePath: "footer.form.fields[0].name",
				suggestedCanonical: "footer.form.fields.email",
				materializeAs: "identity-key",
			},
			{
				sourcePath: "footer.form.fields[0].type",
				suggestedCanonical: "footer.form.fields.email.type",
			},
		]);
		expect(result.collisions).toEqual([]);
		expect(result.chrome).toEqual({
			footer: {
				form: {
					fields: {
						email: {
							type: "email",
						},
					},
				},
			},
		});
		expect(result.provenance).toEqual([
			{
				sourcePath: "footer.form.fields[0].name",
				candidatePath: "footer.form.fields.email",
				role: "identity-key",
			},
			{
				sourcePath: "footer.form.fields[0].type",
				candidatePath: "footer.form.fields.email.type",
				materializedPath: "footer.form.fields.email.type",
			},
		]);
	});
});

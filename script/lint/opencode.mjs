const taggedErrorMessage = {
  meta: {
    type: "problem",
    docs: {
      description: "require Effect tagged errors to expose a message",
    },
    messages: {
      missing: "Schema.TaggedErrorClass must define a message schema field or instance message implementation.",
    },
    schema: [],
  },
  create(context) {
    const schemas = new Set()

    function visitClass(node) {
      const fields = taggedErrorFields(node.superClass, schemas)
      if (
        !fields ||
        fields.properties.some((property) => property.type === "SpreadElement" || property.computed)
      )
        return
      if (fields.properties.some((property) => propertyName(property) === "message")) return
      if (node.body.body.some(hasInstanceMessage)) return
      context.report({ node, messageId: "missing" })
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect" && node.source.value !== "effect/Schema") return
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "Schema") schemas.add(specifier.local.name)
          if (specifier.type === "ImportNamespaceSpecifier" && node.source.value === "effect/Schema")
            schemas.add(specifier.local.name)
        }
      },
      ClassDeclaration: visitClass,
      ClassExpression: visitClass,
    }
  },
}

function taggedErrorFields(superClass, schemas) {
  if (superClass?.type !== "CallExpression" || superClass.arguments.length < 2) return null
  if (superClass.arguments[1].type !== "ObjectExpression") return null
  const factory = superClass.callee
  if (factory.type !== "CallExpression" || factory.arguments.length !== 0) return null
  const taggedError = factory.callee
  if (taggedError.type !== "MemberExpression" || taggedError.computed) return null
  if (taggedError.object.type !== "Identifier" || !schemas.has(taggedError.object.name)) return null
  if (taggedError.property.type !== "Identifier" || taggedError.property.name !== "TaggedErrorClass") return null
  return superClass.arguments[1]
}

function propertyName(property) {
  if (property.type !== "Property" && property.type !== "PropertyDefinition" && property.type !== "MethodDefinition")
    return null
  if (property.computed) return null
  if (property.key.type === "Identifier" || property.key.type === "Literal") return property.key.name ?? property.key.value
  return null
}

function hasInstanceMessage(member) {
  if (member.static || propertyName(member) !== "message") return false
  if (member.type === "MethodDefinition") return member.kind === "get"
  return member.type === "PropertyDefinition" && member.value !== null
}

export default {
  meta: {
    name: "opencode",
  },
  rules: {
    "tagged-error-message": taggedErrorMessage,
  },
}

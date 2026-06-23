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
    function visitClass(node) {
      const fields = taggedErrorFields(context, node.superClass)
      if (!fields) return
      if (fields.properties.some(hasRequiredMessage)) return
      if (node.body.body.some(hasInstanceMessage)) return
      context.report({ node, messageId: "missing" })
    }

    return {
      ClassDeclaration: visitClass,
      ClassExpression: visitClass,
    }
  },
}

function taggedErrorFields(context, superClass) {
  if (superClass?.type !== "CallExpression" || superClass.arguments.length < 2) return null
  if (superClass.arguments[1].type !== "ObjectExpression") return null
  const factory = superClass.callee
  if (factory.type !== "CallExpression" || factory.arguments.length !== 0) return null
  const taggedError = factory.callee
  if (taggedError.type !== "MemberExpression" || taggedError.computed) return null
  if (taggedError.object.type !== "Identifier" || !isEffectSchema(context, taggedError.object)) return null
  if (taggedError.property.type !== "Identifier" || taggedError.property.name !== "TaggedErrorClass") return null
  return superClass.arguments[1]
}

function isEffectSchema(context, identifier) {
  const variable = findVariable(context.sourceCode.getScope(identifier), identifier.name)
  if (!variable || variable.defs.length !== 1 || variable.defs[0].type !== "ImportBinding") return false
  const definition = variable.defs[0]
  if (definition.parent.source.value === "effect")
    return definition.node.type === "ImportSpecifier" && definition.node.imported.name === "Schema"
  return definition.parent.source.value === "effect/Schema" && definition.node.type === "ImportNamespaceSpecifier"
}

function findVariable(scope, name) {
  return scope.set.get(name) ?? (scope.upper ? findVariable(scope.upper, name) : null)
}

function hasRequiredMessage(property) {
  if (propertyName(property) !== "message" || property.type !== "Property") return false
  return isStringSchema(property.value) && !isOptional(property.value)
}

function isStringSchema(node) {
  if (node.type === "MemberExpression")
    return (
      node.object.type === "Identifier" &&
      node.object.name === "Schema" &&
      node.property.type === "Identifier" &&
      node.property.name === "String"
    )
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false
  return isStringSchema(node.callee.object)
}

function isOptional(node) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false
  if (node.callee.object.type === "Identifier" && node.callee.object.name === "Schema")
    return node.callee.property.type === "Identifier" && node.callee.property.name === "optional"
  if (node.callee.property.type !== "Identifier" || node.callee.property.name !== "pipe") return false
  return node.arguments.some(
    (argument) =>
      argument.type === "MemberExpression" &&
      argument.object.type === "Identifier" &&
      argument.object.name === "Schema" &&
      argument.property.type === "Identifier" &&
      argument.property.name === "optional",
  )
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
  if (member.type === "PropertyDefinition") return member.value !== null && !isEmptyMessage(member.value)
  if (member.type !== "MethodDefinition" || member.kind !== "get") return false
  if (member.value.body.body.length === 0) return false
  const direct = member.value.body.body.length === 1 ? member.value.body.body[0] : null
  return direct?.type !== "ReturnStatement" || (direct.argument !== null && !isEmptyMessage(direct.argument))
}

function isEmptyMessage(node) {
  return (node.type === "Identifier" && node.name === "undefined") || (node.type === "Literal" && !node.value)
}

export default {
  meta: {
    name: "opencode",
  },
  rules: {
    "tagged-error-message": taggedErrorMessage,
  },
}

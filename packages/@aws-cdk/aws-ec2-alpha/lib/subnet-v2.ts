import { Resource, Names, Lazy } from 'aws-cdk-lib';
import { CfnRouteTable, CfnSubnet, CfnSubnetRouteTableAssociation, INetworkAcl, IRouteTable, ISubnet, NetworkAcl, SubnetNetworkAclAssociation, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Construct, DependencyGroup, IDependable } from 'constructs';
import { IVpcV2 } from './vpc-v2-base';
import { CidrBlock, CidrBlockIpv6 } from './util';

/**
 * Interface to define subnet CIDR
 */
interface ICidr {
  readonly cidr: string;
}

/**
 * IPv4 or IPv6 CIDR range for the subnet
 */
export class IpCidr implements ICidr {

  /**
 * IPv6 CIDR range for the subnet
 * Allowed only if IPv6 is enabled on VPc
 */
  public readonly cidr: string;
  constructor(props: string ) {
    this.cidr = props;
  }
}

/**
 * Properties to define subnet for VPC.
 */
export interface SubnetV2Props {
/**
 * VPC Prop
 */
  readonly vpc: IVpcV2;

  /**
   * ipv4 cidr to assign to this subnet.
   * See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-subnet.html#cfn-ec2-subnet-cidrblock
   */
  readonly ipv4CidrBlock: IpCidr;

  /**
   * Ipv6 CIDR Range for subnet
   * @default No Ipv6 address
   */
  readonly ipv6CidrBlock?: IpCidr;

  /**
   * Custom AZ for the subnet
   */
  readonly availabilityZone: string;

  /**
   * Custom Route for subnet
   * @default Default route table
   */
  readonly routeTable?: IRouteTable;

  /**
   * The type of Subnet to configure.
   *
   * The Subnet type will control the ability to route and connect to the
   * Internet.
   *
   * TODO: Add validation check `subnetType` when adding resources (e.g. cannot add NatGateway to private)
   */
  readonly subnetType: SubnetType;

  /**
   * Subnet name
   * @default none
   */
  readonly subnetName?: string;

  /**
   * Indicates whether a network interface created in this subnet receives an IPv6 address.
   *
   * If you specify AssignIpv6AddressOnCreation, you must also specify Ipv6CidrBlock.
   *
   * @default false
   */
  readonly assignIpv6AddressOnCreation?: boolean;

}

/**
 * Interface with additional properties for SubnetV2
 */
export interface ISubnetV2 extends ISubnet {

  /**
   * The IPv6 CIDR block for this subnet
   */
  readonly ipv6CidrBlock?: string;

}

/**
 * The SubnetV2 class represents a subnet within a VPC (Virtual Private Cloud) in AWS.
 * It extends the Resource class and implements the ISubnet interface.
 *
 * Instances of this class can be used to create and manage subnets within a VpcV2 instance.
 * Subnets can be configured with specific IP address ranges (IPv4 and IPv6), availability zones,
 * and subnet types (e.g., public, private, isolated).
 *
 * @resource AWS::EC2::Subnet
 *
 */
export class SubnetV2 extends Resource implements ISubnetV2 {

  /**
   * The Availability Zone the subnet is located in
   */
  public readonly availabilityZone: string;

  /**
   * The subnetId for this particular subnet
   * @attribute
   */
  public readonly subnetId: string;

  /**
   *  Dependencies for internet connectivity
   * This Property exposes the RouteTable-Subnet association so that other resources can depend on it.
   */
  public readonly internetConnectivityEstablished: IDependable;

  /**
   * The variable name `internetConnectivityEstablished` does not reflect what it actually is.
   * The naming is enforced by ISubnet. We need to keep it to maintain compatibility.
   * It exposes the RouteTable-Subnet association so that other resources can depend on it.
   * E.g. Resources in a subnet, when being deleted, may need the RouteTable to exist in order to delete properly
   */
  private readonly _internetConnectivityEstablished = new DependencyGroup();

  /**
   * The IPv4 CIDR block for this subnet
   */
  public readonly ipv4CidrBlock: string;

  /**
   * The IPv6 CIDR Block for this subnet
   */
  public readonly ipv6CidrBlock?: string;

  /**
   * The route table for this subnet
   */
  public readonly routeTable: IRouteTable;

  /**
   * The type of subnet (public or private) that this subnet represents.
   * @attribute SubnetType
   */
  public readonly subnetType: SubnetType;

  private _networkAcl: INetworkAcl;

  /**
   * Constructs a new SubnetV2 instance.
   * @param scope The parent Construct that this resource will be part of.
   * @param id The unique identifier for this resource.
   * @param props The configuration properties for the subnet.
   */
  constructor(scope: Construct, id: string, props: SubnetV2Props) {
    super(scope, id, {
      physicalName: props.subnetName ?? Lazy.string({
        produce: () => Names.uniqueResourceName(this, { maxLength: 128, allowedSpecialCharacters: '_' }),
      }),
    });

    const ipv4CidrBlock = props.ipv4CidrBlock.cidr;
    const ipv6CidrBlock = props.ipv6CidrBlock?.cidr;

    if (!checkCidrRanges(props.vpc, props.ipv4CidrBlock.cidr)) {
      throw new Error('CIDR block should be within the range of VPC');
    };

    let overlap: boolean = false;
    let overlapIpv6: boolean = false;

    overlap = validateOverlappingCidrRanges(props.vpc, props.ipv4CidrBlock.cidr);

    //check whether VPC supports ipv6
    if (props.ipv6CidrBlock?.cidr) {
      validateSupportIpv6(props.vpc);
      overlapIpv6 = validateOverlappingCidrRangesipv6(props.vpc, props.ipv6CidrBlock?.cidr);
    }

    if (overlap || overlapIpv6) {
      throw new Error('CIDR block should not overlap with existing subnet blocks');
    }

    if (props.assignIpv6AddressOnCreation && !props.ipv6CidrBlock) {
      throw new Error('IPv6 CIDR block is required when assigning IPv6 address on creation');
    }

    const subnet = new CfnSubnet(this, 'Subnet', {
      vpcId: props.vpc.vpcId,
      cidrBlock: ipv4CidrBlock,
      ipv6CidrBlock: ipv6CidrBlock,
      availabilityZone: props.availabilityZone,
      assignIpv6AddressOnCreation: props.assignIpv6AddressOnCreation ?? false,
    });

    this.node.defaultChild = subnet;
    this.ipv4CidrBlock = props.ipv4CidrBlock.cidr;
    this.ipv6CidrBlock = props.ipv6CidrBlock?.cidr;
    this.subnetId = subnet.ref;
    this.availabilityZone = props.availabilityZone;

    this._networkAcl = NetworkAcl.fromNetworkAclId(this, 'Acl', subnet.attrNetworkAclAssociationId);

    if (props.routeTable) {
      this.routeTable = props.routeTable;
    } else {
      const defaultTable = new CfnRouteTable(this, 'RouteTable', {
        vpcId: props.vpc.vpcId,
      });
      this.routeTable = { routeTableId: defaultTable.ref };
    }

    const routeAssoc = new CfnSubnetRouteTableAssociation(this, 'RouteTableAssociation', {
      subnetId: this.subnetId,
      routeTableId: this.routeTable.routeTableId,
    });
    this._internetConnectivityEstablished.add(routeAssoc);
    this.internetConnectivityEstablished = this._internetConnectivityEstablished;

    this.subnetType = props.subnetType;
    storeSubnetToVpcByType(props.vpc, this, props.subnetType);
  }

  /**
   * Associate a Network ACL with this subnet
   *
   * @param id The unique identifier for this association.
   * @param networkAcl The Network ACL to associate with this subnet.
   * This allows controlling inbound and outbound traffic for instances in this subnet.
   */
  public associateNetworkAcl(id: string, networkAcl: INetworkAcl) {
    this._networkAcl = networkAcl;

    const scope = networkAcl instanceof Construct ? networkAcl : this;
    const other = networkAcl instanceof Construct ? this : networkAcl;
    new SubnetNetworkAclAssociation(scope, id + Names.nodeUniqueId(other.node), {
      networkAcl,
      subnet: this,
    });
  }
  /**
   * Returns the Network ACL associated with this subnet.
   */

  public get networkAcl(): INetworkAcl {
    return this._networkAcl;
  }
}

const subnetTypeMap = {
  [SubnetType.PRIVATE_ISOLATED]: (vpc: IVpcV2, subnet: SubnetV2) => vpc.isolatedSubnets.push(subnet),
  [SubnetType.PUBLIC]: (vpc: IVpcV2, subnet: SubnetV2) => vpc.publicSubnets.push(subnet),
  [SubnetType.PRIVATE_WITH_EGRESS]: (vpc: IVpcV2, subnet: SubnetV2) => vpc.privateSubnets.push(subnet),
  [SubnetType.ISOLATED]: (vpc: IVpcV2, subnet: SubnetV2) => vpc.isolatedSubnets.push(subnet),
  [SubnetType.PRIVATE]: (vpc: IVpcV2, subnet: SubnetV2) => vpc.privateSubnets.push(subnet),
  [SubnetType.PRIVATE_WITH_NAT]: (vpc: IVpcV2, subnet: SubnetV2) => vpc.privateSubnets.push(subnet),
};

/**
 * Stores the provided subnet in the VPC's collection of subnets based on the specified subnet type.
 *
 * @param vpc The VPC instance to which the subnet belongs.
 * @param subnet The subnet instance to be stored.
 * @param type The type of the subnet (e.g., public, private, isolated).
 * @internal
 */
function storeSubnetToVpcByType(vpc: IVpcV2, subnet: SubnetV2, type: SubnetType) {
  const findFunctionType = subnetTypeMap[type];
  if (findFunctionType) {
    findFunctionType(vpc, subnet);
  } else {
    throw new Error(`Unsupported subnet type: ${type}`);
  }

  /**
   * Need to set explicit dependency as during stack deletion,
   * the cidr blocks may get deleted first and will fail as the subnets are still using the cidr blocks
   */
  for (const cidr of vpc.secondaryCidrBlock) {
    subnet.node.addDependency(cidr);
  }
}

/**
 * Validates whether the provided VPC supports IPv6 addresses.
 *
 * @param vpc The VPC instance to be validated.
 * @throws Error if the VPC does not support IPv6 addresses.
 * @returns True if the VPC supports IPv6 addresses, false otherwise.
 * @internal
 */
function validateSupportIpv6(vpc: IVpcV2) {
  if (vpc.secondaryCidrBlock.some((secondaryAddress) => secondaryAddress.amazonProvidedIpv6CidrBlock === true ||
  secondaryAddress.ipv6IpamPoolId != undefined)) {
    return true;
  } else {
    throw new Error('To use IPv6, the VPC must enable IPv6 support.');
  }
}

/**
 * Checks if the provided CIDR range falls within the IP address ranges of the given VPC.
 *
 * @param vpc The VPC instance to check against.
 * @param cidrRange The CIDR range to be checked.
 * @returns True if the CIDR range falls within the VPC's IP address ranges, false otherwise.
 * @internal
 */
function checkCidrRanges(vpc: IVpcV2, cidrRange: string) {

  const vpcCidrBlock = [vpc.ipv4CidrBlock];

  for (const ipAddress of vpc.secondaryCidrBlock) {
    if (ipAddress.cidrBlock) {
      vpcCidrBlock.push(ipAddress.cidrBlock);
    }
  }
  const cidrs = vpcCidrBlock.map(cidr => new CidrBlock(cidr));

  const subnetCidrBlock = new CidrBlock(cidrRange);

  return cidrs.some(c => c.containsCidr(subnetCidrBlock));

}

/**
 * Validates if the provided IPv4 CIDR block overlaps with existing subnet CIDR blocks within the given VPC.
 *
 * @param vpc The VPC instance to check against.
 * @param ipv4CidrBlock The IPv4 CIDR block to be validated.
 * @returns True if the IPv4 CIDR block overlaps with existing subnet CIDR blocks, false otherwise.
 * @internal
 */

function validateOverlappingCidrRanges(vpc: IVpcV2, ipv4CidrBlock: string): boolean {

  let allSubnets: ISubnetV2[];
  try {
    allSubnets = vpc.selectSubnets().subnets;
  } catch (e) {
    'No subnets in VPC';
    return false;
  }

  const ipMap: [string, string][] = new Array();

  const inputRange = new CidrBlock(ipv4CidrBlock);

  const inputIpMap: [string, string] = [inputRange.minIp(), inputRange.maxIp()];

  for (const subnet of allSubnets) {
    const cidrBlock = new CidrBlock(subnet.ipv4CidrBlock);
    ipMap.push([cidrBlock.minIp(), cidrBlock.maxIp()]);
  }

  for (const range of ipMap) {
    if (inputRange.rangesOverlap(range, inputIpMap)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates if the provided IPv6 CIDR block overlaps with existing subnet CIDR blocks within the given VPC.
 *
 * @param vpc The VPC instance to check against.
 * @param ipv6CidrBlock The IPv6 CIDR block to be validated.
 * @returns True if the IPv6 CIDR block overlaps with existing subnet CIDR blocks, false otherwise.
 * @throws Error if no subnets are found in the VPC.
 * @internal
 */
function validateOverlappingCidrRangesipv6(vpc: IVpcV2, ipv6CidrBlock: string): boolean {

  let allSubnets: ISubnetV2[];
  try {
    allSubnets = vpc.selectSubnets().subnets;
  } catch (e) {
    'No subnets in VPC';
    return false;
  }

  const ipv6Map: string[]= [];

  const inputRange = new CidrBlockIpv6(ipv6CidrBlock);

  let result : boolean = false;

  for (const subnet of allSubnets) {
    if (subnet.ipv6CidrBlock) {
      const cidrBlock = new CidrBlockIpv6(subnet.ipv6CidrBlock);
      ipv6Map.push(cidrBlock.cidr);
    }
  }

  for (const range of ipv6Map) {
    if (inputRange.rangesOverlap(range, inputRange.cidr)) {
      result = true;
    }
  }

  return result;
}